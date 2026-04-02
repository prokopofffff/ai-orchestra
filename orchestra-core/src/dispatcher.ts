import { type Config, type AgentRole } from "./config.js";
import { getActiveSessionForRole } from "./session-manager.js";
import { spawnAgent } from "./agent-spawner.js";
import { enqueue } from "./rate-limiter.js";
import { getPool } from "./db.js";

// Maps signal action → which role should be dispatched
const dispatchMap: Record<string, AgentRole | "tech-lead-resume" | null> = {
  // Tech Lead → agents
  create_design_system: "designer",
  create_design: "designer",
  assign_dev: null,         // role is determined from task.assignee_role
  setup_cicd: "devops",
  deploy: "devops",

  // Agents → Tech Lead
  design_system_ready: "tech-lead",
  design_ready: "tech-lead",
  question: "tech-lead",
  pr_created: "tech-lead",  // Tech Lead reviews PR, then user merges
  tests_passed: "tech-lead",
  tests_failed: "tech-lead",

  // System → Tech Lead
  task_blocked: "tech-lead",
  task_unblocked: "tech-lead",

  // Agents → User (no dispatch needed, handled by notification hub)
  escalate: null,
  notify: null,

  // Tech Lead → agents (responses)
  answer: null,             // resume the agent that asked
  pr_approved: null,        // notify user, no agent dispatch
  pr_changes_requested: null, // resume the dev who made the PR
  task_done: null,          // notify user
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

  // Determine target role
  let targetRole = dispatchMap[action];

  // Special cases: determine role from context
  if (action === "assign_dev" && taskId) {
    const { rows } = await getPool().query(
      "SELECT assignee_role FROM tasks WHERE id = $1",
      [taskId],
    );
    if (rows[0]?.assignee_role) {
      targetRole = rows[0].assignee_role as AgentRole;
    } else {
      return { dispatched: false, reason: "Task has no assignee_role" };
    }
  }

  if (action === "answer") {
    if (taskId) {
      const { rows } = await getPool().query(
        "SELECT assignee_role FROM tasks WHERE id = $1",
        [taskId],
      );
      if (rows[0]?.assignee_role) {
        targetRole = rows[0].assignee_role as AgentRole;
      }
    } else {
      // No taskId — dispatch to the signal target role
      const toRole = signal.to;
      if (["designer", "frontend", "backend", "qa", "devops"].includes(toRole)) {
        targetRole = toRole as AgentRole;
        // Find active task for this role
        const { rows } = await getPool().query(
          `SELECT id FROM tasks WHERE project_id = $1 AND assignee_role = $2
           AND state NOT IN ('merged', 'closed') ORDER BY updated_at DESC LIMIT 1`,
          [projectId, toRole],
        );
        if (rows[0]) (signal as { taskId?: string }).taskId = rows[0].id;
      }
    }
  }

  if (action === "pr_changes_requested") {
    if (taskId) {
      const { rows } = await getPool().query(
        "SELECT assignee_role FROM tasks WHERE id = $1",
        [taskId],
      );
      if (rows[0]?.assignee_role) {
        targetRole = rows[0].assignee_role as AgentRole;
      }
    } else {
      // No taskId — find the task by signal target role and project
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
        // Patch taskId for enqueue
        (signal as { taskId?: string }).taskId = rows[0].id;
      }
    }
  }

  if (!targetRole) {
    console.log(`Dispatch: no target for ${action} (from=${signal.from} to=${signal.to})`);
    return { dispatched: false, reason: `No dispatch target for action: ${action}` };
  }

  const role = targetRole as AgentRole;
  console.log(`Dispatch: ${action} → ${role} (project=${projectId.slice(0,8)} task=${taskId?.slice(0,8) ?? 'none'})`);

  // Check if agent is already running for this role+project
  const existing = await getActiveSessionForRole(projectId, role);
  if (existing) {
    // Agent already running — it will pick up the signal via pending signals
    return { dispatched: true, role, reason: "Agent already running, signal queued" };
  }

  // Enqueue for rate-limited spawning
  const finalTaskId = signal.taskId ?? taskId;
  if (!finalTaskId) {
    return { dispatched: false, reason: "No task ID for spawning" };
  }

  const queued = await enqueue({
    projectId,
    taskId: finalTaskId,
    role,
    config,
  });

  return { dispatched: true, role, queued: true };
}

/**
 * On startup, find tasks in active states (designing, in_development, in_testing, in_review)
 * that have an assignee but no running session — re-enqueue them.
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
    // For pr_created: only respawn if there's a pending pr_changes_requested signal
    if (task.state === "pr_created") {
      const { rows: pendingChanges } = await pool.query(
        `SELECT id FROM signals WHERE task_id = $1 AND action = 'pr_changes_requested' AND read = false LIMIT 1`,
        [task.id],
      );
      // Also check signals without task_id aimed at this role
      const { rows: pendingChangesNoTask } = await pool.query(
        `SELECT id FROM signals WHERE project_id = $1 AND to_role = $2 AND action = 'pr_changes_requested' AND read = false LIMIT 1`,
        [task.project_id, task.assignee_role],
      );
      if (!pendingChanges.length && !pendingChangesNoTask.length) continue;
    }

    // Determine role: in_testing → qa, otherwise use assignee_role
    let role: AgentRole;
    if (task.state === "in_testing") {
      role = "qa";
    } else if (task.assignee_role) {
      role = task.assignee_role as AgentRole;
    } else {
      continue;
    }
    console.log(`  [${task.state}] ${role} → task ${task.id}`);
    await enqueue({
      projectId: task.project_id,
      taskId: task.id,
      role,
      config,
    });
  }
}
