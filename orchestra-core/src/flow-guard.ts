import type { AgentRole } from "./config.js";
import { getPool } from "./db.js";

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

const validTransitions: Record<string, string[]> = {
  new: ["described"],
  described: ["designing", "in_development"],
  designing: ["design_ready"],
  design_ready: ["in_development"],
  in_development: ["pr_created"],
  pr_created: ["in_testing", "in_development", "approved"], // TL can approve directly
  in_testing: ["tested", "in_development"],            // allow fix cycle
  tested: ["in_review", "merged"],                     // can skip review if PR already merged
  in_review: ["approved", "in_development", "pr_created"], // allow re-submit
  approved: ["merged", "in_development", "in_testing"],    // approved + merged → QA
  merged: ["closed"],
  closed: [],
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
  tests_failed: "in_development",
  pr_approved: "approved",
  pr_changes_requested: "in_development",
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
