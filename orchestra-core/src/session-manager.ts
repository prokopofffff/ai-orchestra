import { getPool, withAdvisoryLock } from "./db";
import { type AgentRole } from "./config";
import { parseRow, parseRows } from "./db-utils";
import { AgentSessionSchema, type AgentSession } from "@ai-orchestra/shared";

const sessionSchema = AgentSessionSchema;
export type Session = AgentSession;

export interface CreateSessionParams {
  projectId: string;
  role: AgentRole;
  taskId?: string;
  model: string;
  worktreePath?: string;
  /**
   * Project-wide concurrency cap (across all roles). 0/undefined = unlimited.
   * Checked atomically with the insert so concurrent spawns can't slip past it.
   */
  maxConcurrent?: number;
}

export type SpawnConflictReason = "role-busy" | "concurrency-cap";

/**
 * Thrown by createSession when the atomic spawn guard rejects a new session:
 * another agent already holds this role, or the project is at its concurrency
 * cap. Callers treat this as a benign "lost the race / backpressure", not a
 * fatal error — no retry, no crash.
 */
export class SpawnConflictError extends Error {
  constructor(
    public reason: SpawnConflictReason,
    message: string,
    public detail: { existingSessionId?: string; active?: number; cap?: number } = {},
  ) {
    super(message);
    this.name = "SpawnConflictError";
  }
}

/**
 * Create a 'running' session row — the single serialization point for "should
 * I spawn this agent". A transaction-scoped advisory lock keyed on the project
 * makes the role-busy and concurrency-cap checks atomic with the INSERT, so two
 * concurrent dispatches (or the reconciler racing live dispatch) can't both
 * decide to spawn. The lock is cluster-wide (covers multiple worker processes)
 * and auto-releases on COMMIT/ROLLBACK.
 *
 * Throws SpawnConflictError when a same-role session is already running, or the
 * project is at its concurrency cap.
 */
export async function createSession(params: CreateSessionParams): Promise<Session> {
  return withAdvisoryLock(`spawn:${params.projectId}`, async (client) => {
    const { rows: busy } = await client.query(
      `SELECT id FROM sessions
       WHERE project_id = $1 AND role = $2 AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
      [params.projectId, params.role],
    );
    if (busy.length) {
      throw new SpawnConflictError(
        "role-busy",
        `A ${params.role} agent is already running for project ${params.projectId}`,
        { existingSessionId: busy[0].id as string },
      );
    }

    if (params.maxConcurrent && params.maxConcurrent > 0) {
      const { rows: cnt } = await client.query(
        `SELECT count(*)::int AS c FROM sessions
         WHERE project_id = $1 AND status IN ('running', 'sleeping')`,
        [params.projectId],
      );
      const active = cnt[0].c as number;
      if (active >= params.maxConcurrent) {
        throw new SpawnConflictError(
          "concurrency-cap",
          `Project concurrency cap reached (${active}/${params.maxConcurrent})`,
          { active, cap: params.maxConcurrent },
        );
      }
    }

    const { rows } = await client.query(
      `INSERT INTO sessions (project_id, role, task_id, model, worktree_path, status, last_heartbeat)
       VALUES ($1, $2, $3, $4, $5, 'running', now())
       RETURNING *`,
      [params.projectId, params.role, params.taskId ?? null, params.model, params.worktreePath ?? null],
    );
    return parseRow(sessionSchema, rows[0]);
  });
}

export async function updateSession(
  id: string,
  updates: Partial<Pick<Session, "claudeSessionId" | "status" | "worktreePath" | "finishedAt">>,
): Promise<Session | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (updates.claudeSessionId !== undefined) { sets.push(`claude_session_id = $${i++}`); vals.push(updates.claudeSessionId); }
  if (updates.status !== undefined) { sets.push(`status = $${i++}`); vals.push(updates.status); }
  if (updates.worktreePath !== undefined) { sets.push(`worktree_path = $${i++}`); vals.push(updates.worktreePath); }
  if (updates.finishedAt !== undefined) { sets.push(`finished_at = $${i++}`); vals.push(updates.finishedAt); }

  if (!sets.length) return null;

  vals.push(id);
  const { rows } = await getPool().query(
    `UPDATE sessions SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals,
  );
  return rows.length ? parseRow(sessionSchema, rows[0]) : null;
}

export async function updateHeartbeat(id: string): Promise<void> {
  await getPool().query("UPDATE sessions SET last_heartbeat = now() WHERE id = $1", [id]);
}

export async function getSession(id: string): Promise<Session | null> {
  const { rows } = await getPool().query("SELECT * FROM sessions WHERE id = $1", [id]);
  return rows.length ? parseRow(sessionSchema, rows[0]) : null;
}

export async function getActiveSessionForRole(projectId: string, role: AgentRole): Promise<Session | null> {
  const { rows } = await getPool().query(
    `SELECT * FROM sessions
     WHERE project_id = $1 AND role = $2 AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`,
    [projectId, role],
  );
  return rows.length ? parseRow(sessionSchema, rows[0]) : null;
}

export async function getActiveSessions(projectId?: string): Promise<Session[]> {
  if (projectId) {
    const { rows } = await getPool().query(
      "SELECT * FROM sessions WHERE project_id = $1 AND status IN ('running', 'sleeping') ORDER BY started_at DESC",
      [projectId],
    );
    return parseRows(sessionSchema, rows);
  }
  const { rows } = await getPool().query(
    "SELECT * FROM sessions WHERE status IN ('running', 'sleeping') ORDER BY started_at DESC",
  );
  return parseRows(sessionSchema, rows);
}

export async function getLastSessionForRole(projectId: string, role: AgentRole): Promise<Session | null> {
  const { rows } = await getPool().query(
    `SELECT * FROM sessions
     WHERE project_id = $1 AND role = $2
     ORDER BY started_at DESC LIMIT 1`,
    [projectId, role],
  );
  return rows.length ? parseRow(sessionSchema, rows[0]) : null;
}

export async function terminateSession(id: string): Promise<void> {
  await getPool().query(
    "UPDATE sessions SET status = 'terminated', finished_at = now() WHERE id = $1",
    [id],
  );
}

// ─── In-process AbortController registry ──────────────────────────────────
//
// Lives only in the running orchestra-core process. Used by sdk-runner to
// expose the SDK's `Options.abortController` for external cancellation:
// timeout watchdogs, manual kill API, daily-cap watchers. Cleared whenever
// a run terminates so we don't leak signals.

const controllers = new Map<string, AbortController>();

export function registerSessionController(sessionId: string, controller: AbortController): void {
  controllers.set(sessionId, controller);
}

export function unregisterSessionController(sessionId: string): void {
  controllers.delete(sessionId);
}

export function getSessionController(sessionId: string): AbortController | undefined {
  return controllers.get(sessionId);
}

export async function abortSession(sessionId: string, reason: string): Promise<boolean> {
  const c = controllers.get(sessionId);
  if (!c) return false;
  c.abort(reason);
  return true;
}

export async function abortProjectSessions(projectId: string, reason: string): Promise<number> {
  const active = await getActiveSessions(projectId);
  let count = 0;
  for (const s of active) {
    if (await abortSession(s.id, reason)) count++;
  }
  return count;
}
