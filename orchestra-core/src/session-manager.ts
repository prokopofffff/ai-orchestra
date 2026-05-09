import { getPool } from "./db";
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
}

export async function createSession(params: CreateSessionParams): Promise<Session> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO sessions (project_id, role, task_id, model, worktree_path, status, last_heartbeat)
     VALUES ($1, $2, $3, $4, $5, 'running', now())
     RETURNING *`,
    [params.projectId, params.role, params.taskId ?? null, params.model, params.worktreePath ?? null],
  );
  return parseRow(sessionSchema, rows[0]);
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
