import { getPool } from "./db";
import {
  isRouteAllowed,
  isActionAllowedFrom,
  getEdge,
  getTargetState as flowTargetState,
  knownState,
  routePermissions,
  type SenderRole,
  type RecipientRole,
  type TaskState,
} from "./flow";

// Re-exports kept for backward-compat with existing imports.
export { getTargetState, getValidTransitions } from "./flow";

// ─── Types ───

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

// ─── Validation ───

export function validateSignal(signal: SignalPayload): ValidationResult {
  const { from, to, action } = signal;

  if (!(from in routePermissions)) {
    return { allowed: false, reason: `Unknown sender role: ${from}` };
  }
  const fromRole = from as SenderRole;

  if (!isRouteAllowed(fromRole, to as RecipientRole)) {
    return { allowed: false, reason: `Route not allowed: ${from} → ${to}` };
  }

  if (!isActionAllowedFrom(fromRole, action)) {
    return { allowed: false, reason: `Action not allowed for ${from}: ${action}` };
  }

  return { allowed: true };
}

export function validateStateTransition(currentState: string, action: string): ValidationResult {
  const targetState = flowTargetState(action);
  if (!targetState) {
    // Action doesn't trigger a state transition (e.g., question, notify).
    return { allowed: true };
  }

  // Idempotent: same state → same state is a no-op.
  if (currentState === targetState) {
    return { allowed: true };
  }

  if (!knownState(currentState)) {
    return { allowed: false, reason: `Unknown state: ${currentState}` };
  }

  // Per-edge gating: the action's source-state allowlist is the source of truth
  // for whether THIS action can fire from THIS state.
  const edge = getEdge(action);
  const allowedSources = edge?.transition?.from ?? [];
  if (!allowedSources.includes(currentState as TaskState)) {
    return {
      allowed: false,
      reason: `Invalid transition: ${currentState} → ${targetState} (via ${action})`,
    };
  }

  return { allowed: true };
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
