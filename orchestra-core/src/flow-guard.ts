import { Pool } from "pg";
import { z } from "zod";
import { AgentRole, AgentRoleSchema } from "./session-manager.js";
import { SignalActionSchema } from "./signal-api.js";

// --- Allowed signal routes ---

type SignalAction = z.infer<typeof SignalActionSchema>;

const ALLOWED_ROUTES: Record<string, Set<string>> = {
  "tech-lead": new Set([
    "designer", "frontend", "backend", "qa", "devops", "user",
  ]),
  designer: new Set(["tech-lead", "user"]),
  frontend: new Set(["tech-lead", "qa", "user"]),
  backend: new Set(["tech-lead", "qa", "user"]),
  qa: new Set(["tech-lead", "user"]),
  devops: new Set(["tech-lead", "user"]),
  // External sources
  github: new Set(["tech-lead", "qa"]),
  gitlab: new Set(["tech-lead", "qa"]),
  telegram: new Set(["tech-lead"]),
};

const ALLOWED_ACTIONS: Record<string, Set<SignalAction>> = {
  "tech-lead": new Set([
    "assign_dev", "create_design", "create_design_system",
    "answer", "deploy", "setup_cicd", "task_done",
    "escalate", "notify", "pr_approved", "pr_changes_requested",
  ]),
  designer: new Set([
    "design_ready", "design_system_ready", "question", "escalate", "notify",
  ]),
  frontend: new Set([
    "pr_created", "question", "escalate", "notify",
  ]),
  backend: new Set([
    "pr_created", "question", "escalate", "notify",
  ]),
  qa: new Set([
    "tests_passed", "question", "escalate", "notify",
  ]),
  devops: new Set([
    "task_done", "question", "escalate", "notify",
  ]),
  github: new Set([
    "pr_created", "pr_review_update", "push",
  ]),
  gitlab: new Set([
    "pr_created", "pr_review_update", "push",
  ]),
  telegram: new Set([
    "notify",
  ]),
};

// --- Task state machine ---

export const TaskStateSchema = z.enum([
  "new",
  "described",
  "designing",
  "design_ready",
  "in_development",
  "pr_created",
  "in_testing",
  "tested",
  "in_review",
  "approved",
  "merged",
  "closed",
  "rejected",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

const STATE_TRANSITIONS: Record<TaskState, Set<TaskState>> = {
  new: new Set(["described"]),
  described: new Set(["designing", "in_development"]), // in_development only for non-UI tasks
  designing: new Set(["design_ready"]),
  design_ready: new Set(["in_development"]),
  in_development: new Set(["pr_created"]),
  pr_created: new Set(["in_testing"]),
  in_testing: new Set(["tested", "in_development"]), // back to dev if tests fail
  tested: new Set(["in_review"]),
  in_review: new Set(["approved", "in_development"]), // back to dev if changes requested
  approved: new Set(["merged"]),
  merged: new Set(["closed"]),
  closed: new Set([]),
  rejected: new Set([]),
};

// Which actions trigger which state transitions
const ACTION_STATE_MAP: Partial<Record<SignalAction, { from: TaskState[]; to: TaskState }>> = {
  create_design: { from: ["described"], to: "designing" },
  design_ready: { from: ["designing"], to: "design_ready" },
  assign_dev: { from: ["described", "design_ready", "in_development"], to: "in_development" },
  pr_created: { from: ["in_development"], to: "pr_created" },
  tests_passed: { from: ["in_testing"], to: "tested" },
  pr_approved: { from: ["in_review"], to: "approved" },
  pr_changes_requested: { from: ["in_review"], to: "in_development" },
};

// --- Validation result ---

export const FlowGuardResultSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().optional(),
  stateTransition: z.object({
    from: TaskStateSchema,
    to: TaskStateSchema,
  }).optional(),
});
export type FlowGuardResult = z.infer<typeof FlowGuardResultSchema>;

// --- Flow Guard ---

export class FlowGuard {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS task_states (
        task_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'new',
        has_design BOOLEAN DEFAULT FALSE,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS flow_audit_log (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        action TEXT NOT NULL,
        task_id TEXT,
        allowed BOOLEAN NOT NULL,
        reason TEXT,
        context JSONB DEFAULT '{}'
      )
    `);
  }

  async validate(
    from: string,
    to: string,
    action: string,
    taskId?: string
  ): Promise<FlowGuardResult> {
    // 1. Check allowed route
    const allowedRecipients = ALLOWED_ROUTES[from];
    if (!allowedRecipients || !allowedRecipients.has(to)) {
      return this.reject(from, to, action, taskId,
        `${from} cannot send signals to ${to}`
      );
    }

    // 2. Check allowed action for sender
    const allowedActions = ALLOWED_ACTIONS[from];
    if (allowedActions && !allowedActions.has(action as SignalAction)) {
      return this.reject(from, to, action, taskId,
        `${from} cannot perform action '${action}'`
      );
    }

    // 3. Check state machine (if task_id provided and action has state mapping)
    const stateMapping = ACTION_STATE_MAP[action as SignalAction];
    if (stateMapping && taskId) {
      const currentState = await this.getTaskState(taskId);

      if (currentState && !stateMapping.from.includes(currentState)) {
        return this.reject(from, to, action, taskId,
          `Cannot '${action}' on task ${taskId}: current state is '${currentState}', expected one of [${stateMapping.from.join(", ")}]`
        );
      }

      // State transition is valid — will be applied after signal is processed
      await this.audit(from, to, action, taskId, true);
      return {
        allowed: true,
        stateTransition: currentState
          ? { from: currentState, to: stateMapping.to }
          : undefined,
      };
    }

    // 4. No state constraints — allow
    await this.audit(from, to, action, taskId, true);
    return { allowed: true };
  }

  async transitionTaskState(
    taskId: string,
    projectId: string,
    newState: TaskState
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO task_states (task_id, project_id, state, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (task_id) DO UPDATE SET state = $3, updated_at = NOW()`,
      [taskId, projectId, newState]
    );
  }

  async setTaskHasDesign(taskId: string, hasDesign: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE task_states SET has_design = $2 WHERE task_id = $1`,
      [taskId, hasDesign]
    );
  }

  async getTaskState(taskId: string): Promise<TaskState | null> {
    const result = await this.pool.query(
      `SELECT state FROM task_states WHERE task_id = $1`,
      [taskId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0].state as TaskState;
  }

  async getAuditLog(limit: number = 50): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT * FROM flow_audit_log ORDER BY timestamp DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async getViolations(limit: number = 50): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT * FROM flow_audit_log WHERE allowed = FALSE ORDER BY timestamp DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  private async reject(
    from: string,
    to: string,
    action: string,
    taskId: string | undefined,
    reason: string
  ): Promise<FlowGuardResult> {
    await this.audit(from, to, action, taskId, false, reason);
    console.warn(`[FLOW GUARD] REJECTED: ${from} → ${to} (${action}): ${reason}`);
    return { allowed: false, reason };
  }

  private async audit(
    from: string,
    to: string,
    action: string,
    taskId: string | undefined,
    allowed: boolean,
    reason?: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO flow_audit_log (from_agent, to_agent, action, task_id, allowed, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [from, to, action, taskId || null, allowed, reason || null]
    );
  }
}
