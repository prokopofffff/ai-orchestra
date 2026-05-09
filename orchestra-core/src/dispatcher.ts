import { type Config, type AgentRole } from "./config";
import { getActiveSessionForRole, getActiveSessions } from "./session-manager";
import { enqueue } from "./rate-limiter";
import { getPool } from "./db";
import { checkUnblocked } from "./dependency-engine";
import { logBackgroundError } from "./error-handler";
import { getEdge, type Edge, type Target } from "./flow";
import { resolveMaxConcurrentSessions } from "./limits";
import { log } from "./obs";

export interface DispatchResult {
  dispatched: boolean;
  role?: AgentRole;
  queued?: boolean;
  reason?: string;
}

type Signal = {
  from: string;
  to: string;
  action: string;
  projectId: string;
  taskId?: string;
};

const AGENT_ROLES: readonly AgentRole[] = ["tech-lead", "designer", "frontend", "backend", "qa", "devops"];

function isAgentRole(s: string): s is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(s);
}

/**
 * Drive a signal through its flow.ts edge:
 *   - look up the edge
 *   - resolve the canonical target (role / task-assignee / user)
 *   - apply the effect (spawn / auto-unblock / notify-user / store-only)
 *
 * The signal is already validated + stored by signal-api before this runs.
 */
export async function dispatchSignal(signal: Signal, config: Config): Promise<DispatchResult> {
  const edge = getEdge(signal.action);
  if (!edge) {
    return { dispatched: false, reason: `No edge for action: ${signal.action}` };
  }

  switch (edge.effect.kind) {
    case "auto-unblock":
      return await applyAutoUnblock(edge, signal);

    case "notify-user":
      // signal-api already calls notify() for user-facing actions.
      return { dispatched: false, reason: `Auto-handled: ${signal.action} → user` };

    case "store-only":
      return { dispatched: false, reason: `Stored: ${signal.action}` };

    case "spawn":
      return await applySpawn(edge, signal, config);
  }
}

async function applyAutoUnblock(edge: Edge, signal: Signal): Promise<DispatchResult> {
  if (!signal.taskId) {
    return { dispatched: true, reason: `Auto-handled: ${signal.action} (no task)` };
  }
  await notifyTechLead(signal.projectId, `${edge.description} (task ${signal.taskId})`);
  await checkUnblocked(signal.taskId, signal.projectId).catch((e) =>
    logBackgroundError("dispatch:unblock", e, signal.projectId),
  );
  return { dispatched: true, reason: `Auto-handled: ${signal.action}` };
}

async function applySpawn(edge: Edge, signal: Signal, config: Config): Promise<DispatchResult> {
  const targetRole = await resolveTarget(edge.target, signal);
  if (!targetRole) {
    if (edge.target.kind === "task-assignee") {
      // Strict: surface to TL so unassigned tasks don't silently stall.
      if (signal.taskId) {
        await notifyTechLead(signal.projectId, `Task ${signal.taskId} needs assignment for ${signal.action}`);
      }
      return { dispatched: false, reason: `Task has no assignee_role for ${signal.action}` };
    }
    return { dispatched: false, reason: `No target resolved for ${signal.action}` };
  }

  log.info({
    action: signal.action,
    targetRole,
    projectId: signal.projectId,
    taskId: signal.taskId,
  }, "dispatching signal");

  const existing = await getActiveSessionForRole(signal.projectId, targetRole);
  if (existing) {
    return { dispatched: true, role: targetRole, reason: "Agent already running, signal queued" };
  }

  const taskId = signal.taskId ?? (await findOpenTaskFor(signal.projectId, targetRole));
  if (!taskId) {
    return { dispatched: false, reason: `No task to dispatch ${targetRole} on` };
  }

  // Frozen tasks block all spawns. Set by safety caps (revisions, failed,
  // budget); cleared via /tasks/:id/unfreeze.
  const frozen = await getFrozenReason(taskId);
  if (frozen) {
    log.info({ taskId, reason: frozen }, "skip spawn: task is frozen");
    return { dispatched: false, reason: `Task frozen: ${frozen}` };
  }

  // Project-level concurrency cap. Prevents the orchestra from running all
  // six roles in parallel and tripping rate limits / token costs all at once.
  // Signal stays in DB; reconcile or the next heartbeat picks it up later.
  const concurrencyCheck = await checkProjectConcurrency(signal.projectId);
  if (!concurrencyCheck.ok) {
    log.info(concurrencyCheck, "skip spawn: project concurrency cap");
    return { dispatched: false, reason: `Project concurrency cap reached (${concurrencyCheck.active}/${concurrencyCheck.cap})` };
  }

  await enqueue({ projectId: signal.projectId, taskId, role: targetRole, config });
  return { dispatched: true, role: targetRole, queued: true };
}

async function checkProjectConcurrency(projectId: string): Promise<
  { ok: true } | { ok: false; active: number; cap: number; projectId: string }
> {
  const { rows } = await getPool().query("SELECT settings FROM projects WHERE id = $1", [projectId]);
  const cap = resolveMaxConcurrentSessions(rows[0]?.settings);
  const active = (await getActiveSessions(projectId)).length;
  if (active >= cap) return { ok: false, active, cap, projectId };
  return { ok: true };
}

async function getFrozenReason(taskId: string): Promise<string | null> {
  const { rows } = await getPool().query(
    "SELECT frozen_reason FROM tasks WHERE id = $1",
    [taskId],
  );
  return (rows[0]?.frozen_reason as string | null) ?? null;
}

/**
 * Resolve an edge's target into a concrete agent role at dispatch time.
 *   - { role: X }    → X (unless X === "user", which can't be spawned)
 *   - { user }       → null (signal-api handles user notification separately)
 *   - { task-assignee } → task.assignee_role; falls back to signal.to if it
 *                          names a known agent role (so "answer"/"changes_requested"
 *                          without a taskId still resume the addressed agent).
 */
async function resolveTarget(target: Target, signal: Signal): Promise<AgentRole | null> {
  switch (target.kind) {
    case "user":
      return null;

    case "role":
      return target.role === "user" ? null : target.role;

    case "task-assignee": {
      // Strict: must come from task.assignee_role.
      if (!signal.taskId) return null;
      const { rows } = await getPool().query(
        "SELECT assignee_role FROM tasks WHERE id = $1",
        [signal.taskId],
      );
      const role = rows[0]?.assignee_role as string | undefined;
      return role && isAgentRole(role) ? role : null;
    }

    case "addressed-role": {
      // Prefer task assignee if a task is given; else fall back to who was addressed.
      if (signal.taskId) {
        const { rows } = await getPool().query(
          "SELECT assignee_role FROM tasks WHERE id = $1",
          [signal.taskId],
        );
        const role = rows[0]?.assignee_role as string | undefined;
        if (role && isAgentRole(role)) return role;
      }
      return isAgentRole(signal.to) ? signal.to : null;
    }
  }
}

async function findOpenTaskFor(projectId: string, role: AgentRole): Promise<string | null> {
  const { rows } = await getPool().query(
    `SELECT id FROM tasks
     WHERE project_id = $1 AND assignee_role = $2 AND state NOT IN ('merged', 'closed')
     ORDER BY updated_at DESC LIMIT 1`,
    [projectId, role],
  );
  return rows[0]?.id ?? null;
}

/**
 * Send a non-blocking notification to Tech Lead (signal stored, no dispatch).
 */
async function notifyTechLead(projectId: string, message: string): Promise<void> {
  await getPool().query(
    `INSERT INTO signals (project_id, from_role, to_role, action, payload)
     VALUES ($1, 'system', 'tech-lead', 'notify', $2)`,
    [projectId, JSON.stringify({ message })],
  ).catch((e) => logBackgroundError("dispatch:notifyTL", e, projectId));
}

/**
 * On startup, find tasks in active states with no running session — re-enqueue them.
 */
export async function reconcileOrphanedTasks(config: Config): Promise<void> {
  const pool = getPool();

  const activeStates = ["designing", "in_development", "in_testing", "in_review", "pr_created"];
  const { rows: orphaned } = await pool.query(
    `SELECT t.id, t.project_id, t.assignee_role, t.state
     FROM tasks t
     WHERE t.state = ANY($1)
       AND t.frozen_reason IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM sessions s
         WHERE s.task_id = t.id AND s.status = 'running'
       )`,
    [activeStates],
  );

  if (!orphaned.length) return;

  log.info({ count: orphaned.length }, "reconciling orphaned tasks");
  for (const task of orphaned) {
    // pr_created: only respawn if pending pr_changes_requested
    if (task.state === "pr_created") {
      const { rows: pending } = await pool.query(
        `SELECT id FROM signals
         WHERE (task_id = $1 OR (project_id = $2 AND to_role = $3))
         AND action = 'pr_changes_requested' AND read = false LIMIT 1`,
        [task.id, task.project_id, task.assignee_role],
      );
      if (!pending.length) continue;
    }

    let role: AgentRole;
    if (task.state === "in_testing") {
      role = "qa";
    } else if (task.assignee_role && isAgentRole(task.assignee_role)) {
      role = task.assignee_role;
    } else {
      continue;
    }

    log.info({ state: task.state, role, taskId: task.id }, "reconcile → enqueue");
    await enqueue({ projectId: task.project_id, taskId: task.id, role, config });
  }
}
