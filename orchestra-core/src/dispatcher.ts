import { type Config, type AgentRole } from "./config";
import { getActiveSessionForRole } from "./session-manager";
import { enqueue } from "./rate-limiter";
import { getPool } from "./db";
import { checkUnblocked } from "./dependency-engine";
import { notify } from "./notification-hub";
import { appendLog } from "./logger";
import { logBackgroundError } from "./error-handler";

/**
 * Dispatch map: signal action → target role.
 * null = requires special handling (see dispatchSignal).
 */
const dispatchMap: Record<string, AgentRole | null> = {
  // Tech Lead → agents
  create_design_system: "designer",
  create_design: "designer",
  assign_dev: null,         // role from task.assignee_role
  setup_cicd: "devops",
  deploy: "devops",

  // Require Tech Lead decision
  pr_created: "tech-lead",   // PR review — must go through TL
  question: "tech-lead",     // Questions need TL answer
  tests_failed: "tech-lead", // Failed tests need TL decision

  // Auto-dispatch (bypass Tech Lead, notify only)
  design_system_ready: null, // auto-handle: update state + unblock
  design_ready: null,        // auto-handle: update state + unblock
  tests_passed: null,        // auto-handle: update state + unblock
  task_blocked: null,        // informational
  task_unblocked: null,      // auto-handle: dispatch unblocked agent

  // User-facing (no agent dispatch)
  escalate: null,
  notify: null,

  // Tech Lead → agents (responses)
  answer: null,
  pr_approved: null,
  pr_changes_requested: null,
  task_done: null,
};

export interface DispatchResult {
  dispatched: boolean;
  role?: AgentRole;
  queued?: boolean;
  reason?: string;
}

export async function dispatchSignal(
  signal: { from: string; to: string; action: string; projectId: string; taskId?: string },
  config: Config,
): Promise<DispatchResult> {
  const { action, projectId, taskId } = signal;

  // ─── Auto-dispatch signals (bypass Tech Lead) ───

  // design_ready / design_system_ready → notify TL, trigger unblock
  if ((action === "design_ready" || action === "design_system_ready") && taskId) {
    await notifyTechLead(projectId, `Design completed for task ${taskId}`);
    await checkUnblocked(taskId, projectId).catch((e) => logBackgroundError("dispatch:unblock", e, projectId));
    return { dispatched: true, reason: "Auto-handled: design ready, checked unblock" };
  }

  // tests_passed → notify TL, trigger unblock
  if (action === "tests_passed" && taskId) {
    await notifyTechLead(projectId, `Tests passed for task ${taskId}`);
    await checkUnblocked(taskId, projectId).catch((e) => logBackgroundError("dispatch:unblock", e, projectId));
    return { dispatched: true, reason: "Auto-handled: tests passed, checked unblock" };
  }

  // task_unblocked → auto-dispatch the unblocked agent
  if (action === "task_unblocked" && taskId) {
    const { rows } = await getPool().query(
      "SELECT assignee_role FROM tasks WHERE id = $1",
      [taskId],
    );
    const role = rows[0]?.assignee_role as AgentRole | undefined;
    if (role) {
      console.log(`Dispatch: task_unblocked → auto-dispatching ${role} (task=${taskId?.slice(0, 8)})`);
      return await enqueueAgent(projectId, taskId, role, config);
    }
    // No assignee — notify Tech Lead to assign
    await notifyTechLead(projectId, `Task ${taskId} unblocked but has no assignee`);
    return { dispatched: false, reason: "Unblocked task has no assignee" };
  }

  // ─── Standard dispatch ───

  let targetRole = dispatchMap[action] ?? null;

  // assign_dev → role from task.assignee_role
  if (action === "assign_dev" && taskId) {
    const { rows } = await getPool().query("SELECT assignee_role FROM tasks WHERE id = $1", [taskId]);
    if (rows[0]?.assignee_role) {
      targetRole = rows[0].assignee_role as AgentRole;
    } else {
      return { dispatched: false, reason: "Task has no assignee_role" };
    }
  }

  // answer → resume the agent who asked
  if (action === "answer") {
    if (taskId) {
      const { rows } = await getPool().query("SELECT assignee_role FROM tasks WHERE id = $1", [taskId]);
      if (rows[0]?.assignee_role) targetRole = rows[0].assignee_role as AgentRole;
    } else {
      const toRole = signal.to;
      if (["designer", "frontend", "backend", "qa", "devops"].includes(toRole)) {
        targetRole = toRole as AgentRole;
        const { rows } = await getPool().query(
          `SELECT id FROM tasks WHERE project_id = $1 AND assignee_role = $2
           AND state NOT IN ('merged', 'closed') ORDER BY updated_at DESC LIMIT 1`,
          [projectId, toRole],
        );
        if (rows[0]) (signal as { taskId?: string }).taskId = rows[0].id;
      }
    }
  }

  // pr_changes_requested → resume the dev
  if (action === "pr_changes_requested") {
    if (taskId) {
      const { rows } = await getPool().query("SELECT assignee_role FROM tasks WHERE id = $1", [taskId]);
      if (rows[0]?.assignee_role) targetRole = rows[0].assignee_role as AgentRole;
    } else {
      const toRole = signal.to;
      const { rows } = await getPool().query(
        `SELECT id, assignee_role FROM tasks
         WHERE project_id = $1 AND assignee_role = $2
         AND state IN ('pr_created', 'in_development', 'in_review')
         ORDER BY updated_at DESC LIMIT 1`,
        [projectId, toRole],
      );
      if (rows[0]) {
        targetRole = rows[0].assignee_role as AgentRole;
        (signal as { taskId?: string }).taskId = rows[0].id;
      }
    }
  }

  if (!targetRole) {
    console.log(`Dispatch: no target for ${action} (from=${signal.from} to=${signal.to})`);
    return { dispatched: false, reason: `No dispatch target for action: ${action}` };
  }

  console.log(`Dispatch: ${action} → ${targetRole} (project=${projectId.slice(0, 8)} task=${taskId?.slice(0, 8) ?? "none"})`);

  // Check if agent already running
  const existing = await getActiveSessionForRole(projectId, targetRole);
  if (existing) {
    return { dispatched: true, role: targetRole, reason: "Agent already running, signal queued" };
  }

  const finalTaskId = signal.taskId ?? taskId;
  if (!finalTaskId) {
    return { dispatched: false, reason: "No task ID for spawning" };
  }

  return await enqueueAgent(projectId, finalTaskId, targetRole, config);
}

async function enqueueAgent(
  projectId: string,
  taskId: string,
  role: AgentRole,
  config: Config,
): Promise<DispatchResult> {
  await enqueue({ projectId, taskId, role, config });
  return { dispatched: true, role, queued: true };
}

/**
 * Send a non-blocking notification to Tech Lead (signal stored, no dispatch).
 * Tech Lead picks it up on next session. Does NOT block the pipeline.
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
       AND NOT EXISTS (
         SELECT 1 FROM sessions s
         WHERE s.task_id = t.id AND s.status = 'running'
       )`,
    [activeStates],
  );

  if (!orphaned.length) return;

  console.log(`Reconciling ${orphaned.length} orphaned task(s):`);
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
    } else if (task.assignee_role) {
      role = task.assignee_role as AgentRole;
    } else {
      continue;
    }

    console.log(`  [${task.state}] ${role} → task ${task.id}`);
    await enqueue({ projectId: task.project_id, taskId: task.id, role, config });
  }
}
