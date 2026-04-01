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
  pr_created: null,         // dispatches QA
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

  if (action === "pr_created" && taskId) {
    // PR created → dispatch QA
    targetRole = "qa";
  }

  if (action === "answer" && taskId) {
    // Answer → resume the agent working on this task
    const { rows } = await getPool().query(
      "SELECT assignee_role FROM tasks WHERE id = $1",
      [taskId],
    );
    if (rows[0]?.assignee_role) {
      targetRole = rows[0].assignee_role as AgentRole;
    }
  }

  if (action === "pr_changes_requested" && taskId) {
    // Resume dev who made the PR
    const { rows } = await getPool().query(
      "SELECT assignee_role FROM tasks WHERE id = $1",
      [taskId],
    );
    if (rows[0]?.assignee_role) {
      targetRole = rows[0].assignee_role as AgentRole;
    }
  }

  if (!targetRole) {
    return { dispatched: false, reason: `No dispatch target for action: ${action}` };
  }

  const role = targetRole as AgentRole;

  // Check if agent is already running for this role+project
  const existing = await getActiveSessionForRole(projectId, role);
  if (existing) {
    // Agent already running — it will pick up the signal via pending signals
    return { dispatched: true, role, reason: "Agent already running, signal queued" };
  }

  // Enqueue for rate-limited spawning
  if (!taskId) {
    return { dispatched: false, reason: "No task ID for spawning" };
  }

  const queued = await enqueue({
    projectId,
    taskId,
    role,
    config,
  });

  return { dispatched: true, role, queued: true };
}
