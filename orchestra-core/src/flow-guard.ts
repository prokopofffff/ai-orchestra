import type { AgentRole } from "./config";
import { getPool } from "./db";

// ─── Allowed Routes ───

const allowedRoutes: Record<string, string[]> = {
  "tech-lead": ["designer", "frontend", "backend", "qa", "devops", "user"],
  designer: ["tech-lead", "user"],
  frontend: ["tech-lead", "qa", "user"],
  backend: ["tech-lead", "qa", "user"],
  qa: ["tech-lead", "user"],
  devops: ["tech-lead", "user"],
  system: ["tech-lead", "user"],
};

// ─── Allowed Actions per Role ───

const allowedActions: Record<string, string[]> = {
  "tech-lead": [
    "create_design_system", "create_design", "assign_dev",
    "answer", "question", "pr_approved", "pr_changes_requested",
    "task_done", "deploy", "setup_cicd", "notify", "escalate",
  ],
  designer: [
    "design_system_ready", "design_ready", "question", "escalate", "notify",
  ],
  frontend: [
    "pr_created", "question", "escalate", "notify",
  ],
  backend: [
    "pr_created", "question", "escalate", "notify",
  ],
  qa: [
    "tests_passed", "tests_failed", "question", "escalate", "notify",
  ],
  devops: [
    "deploy_done", "cicd_ready", "question", "escalate", "notify",
  ],
  system: [
    "task_blocked", "task_unblocked",
  ],
};

// ─── Task State Machine ───

/*
 * State machine with full lifecycle including revisions, failure, and cancellation.
 *
 * Happy path:
 *   new → described → designing → design_ready → in_development → pr_created
 *   → in_testing → tested → in_review → approved → merged → closed
 *
 * Revisions loop:
 *   pr_created → revisions (TL requests changes) → pr_created (dev re-submits)
 *
 * Failure/cancellation (from any active state):
 *   * → failed     (unrecoverable error)
 *   * → cancelled  (user/TL cancels task)
 *
 * Recovery from failure:
 *   failed → in_development  (retry)
 *   cancelled → new          (reopen)
 */
const validTransitions: Record<string, string[]> = {
  new:            ["described", "cancelled"],
  described:      ["designing", "in_development", "cancelled"],
  designing:      ["design_ready", "failed", "cancelled"],
  design_ready:   ["in_development", "cancelled"],
  in_development: ["pr_created", "failed", "cancelled"],
  pr_created:     ["in_testing", "revisions", "approved", "cancelled"],
  revisions:      ["pr_created", "in_development", "failed", "cancelled"],
  in_testing:     ["tested", "in_development", "failed", "cancelled"],
  tested:         ["in_review", "merged"],
  in_review:      ["approved", "revisions", "in_development", "cancelled"],
  approved:       ["merged", "in_testing"],
  merged:         ["closed"],
  closed:         [],
  failed:         ["in_development", "new", "cancelled"],
  cancelled:      ["new"],
};

// Action → state transition mapping
const actionToTransition: Record<string, string> = {
  create_design: "designing",
  create_design_system: "designing",
  design_ready: "design_ready",
  design_system_ready: "design_ready",
  assign_dev: "in_development",
  pr_created: "pr_created",
  tests_passed: "tested",
  tests_failed: "failed",
  pr_approved: "approved",
  pr_changes_requested: "revisions",
};

// ─── Validation ───

export interface SignalPayload {
  from: string;
  to: string;
  action: string;
  projectId: string;
  taskId?: string;
  message?: string;
  payload?: Record<string, unknown>;
}

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
}

export function validateSignal(signal: SignalPayload): ValidationResult {
  const { from, to, action } = signal;

  // Check route
  const routes = allowedRoutes[from];
  if (!routes) {
    return { allowed: false, reason: `Unknown sender role: ${from}` };
  }
  if (!routes.includes(to)) {
    return { allowed: false, reason: `Route not allowed: ${from} → ${to}` };
  }

  // Check action
  const actions = allowedActions[from];
  if (!actions) {
    return { allowed: false, reason: `No actions defined for role: ${from}` };
  }
  if (!actions.includes(action)) {
    return { allowed: false, reason: `Action not allowed for ${from}: ${action}` };
  }

  return { allowed: true };
}

export function validateStateTransition(currentState: string, action: string): ValidationResult {
  const targetState = actionToTransition[action];
  if (!targetState) {
    // Action doesn't trigger a state transition (e.g., question, notify)
    return { allowed: true };
  }

  // Idempotent: if already in target state, allow (no-op)
  if (currentState === targetState) {
    return { allowed: true };
  }

  const allowed = validTransitions[currentState];
  if (!allowed) {
    return { allowed: false, reason: `Unknown state: ${currentState}` };
  }

  if (!allowed.includes(targetState)) {
    return { allowed: false, reason: `Invalid transition: ${currentState} → ${targetState} (via ${action})` };
  }

  return { allowed: true };
}

export function getTargetState(action: string): string | null {
  return actionToTransition[action] ?? null;
}

export function getValidTransitions(state: string): string[] {
  return validTransitions[state] ?? [];
}

// ─── Audit Logging ───

export async function logAudit(
  signal: SignalPayload,
  status: "allowed" | "rejected",
  reason?: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO flow_audit (project_id, from_role, to_role, action, task_id, status, reason, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      signal.projectId,
      signal.from,
      signal.to,
      signal.action,
      signal.taskId ?? null,
      status,
      reason ?? null,
      JSON.stringify(signal.payload ?? {}),
    ],
  );
}
