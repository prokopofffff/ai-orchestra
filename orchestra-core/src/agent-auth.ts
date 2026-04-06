import { type AgentRole } from "./config";

/**
 * Per-role permissions for API operations.
 * Restricts what each agent role can do through MCP tools.
 */

// Task operations: who can create/update/delete tasks
const taskPermissions: Record<AgentRole, {
  canCreate: boolean;
  canDelete: boolean;
  canUpdateAnyTask: boolean;       // false = can only update own assigned tasks
  canChangeState: boolean;
  allowedStateChanges?: string[];   // if set, only these states are allowed
}> = {
  "tech-lead": {
    canCreate: true,
    canDelete: true,
    canUpdateAnyTask: true,
    canChangeState: true,
  },
  designer: {
    canCreate: false,
    canDelete: false,
    canUpdateAnyTask: false,
    canChangeState: true,
    allowedStateChanges: ["designing", "design_ready", "failed"],
  },
  frontend: {
    canCreate: false,
    canDelete: false,
    canUpdateAnyTask: false,
    canChangeState: true,
    allowedStateChanges: ["in_development", "pr_created", "revisions", "failed"],
  },
  backend: {
    canCreate: false,
    canDelete: false,
    canUpdateAnyTask: false,
    canChangeState: true,
    allowedStateChanges: ["in_development", "pr_created", "revisions", "failed"],
  },
  qa: {
    canCreate: false,
    canDelete: false,
    canUpdateAnyTask: false,
    canChangeState: true,
    allowedStateChanges: ["in_testing", "tested", "failed"],
  },
  devops: {
    canCreate: false,
    canDelete: false,
    canUpdateAnyTask: false,
    canChangeState: true,
    allowedStateChanges: ["in_development", "pr_created"],
  },
};

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Validate that an agent can create a task.
 */
export function canCreateTask(role: AgentRole): ValidationResult {
  const perms = taskPermissions[role];
  if (!perms?.canCreate) {
    return { allowed: false, reason: `Role ${role} cannot create tasks` };
  }
  return { allowed: true };
}

/**
 * Validate that an agent can update a specific task.
 */
export function canUpdateTask(
  role: AgentRole,
  taskAssigneeRole: string | null,
  updates: { state?: string },
): ValidationResult {
  const perms = taskPermissions[role];
  if (!perms) return { allowed: false, reason: `Unknown role: ${role}` };

  // Check task ownership (non-tech-lead can only update own tasks)
  if (!perms.canUpdateAnyTask && taskAssigneeRole !== role) {
    return { allowed: false, reason: `Role ${role} can only update tasks assigned to ${role}` };
  }

  // Check state change permissions
  if (updates.state && perms.allowedStateChanges) {
    if (!perms.allowedStateChanges.includes(updates.state)) {
      return { allowed: false, reason: `Role ${role} cannot set state to ${updates.state}` };
    }
  }

  return { allowed: true };
}

/**
 * Validate that an agent can delete a task.
 */
export function canDeleteTask(role: AgentRole): ValidationResult {
  const perms = taskPermissions[role];
  if (!perms?.canDelete) {
    return { allowed: false, reason: `Role ${role} cannot delete tasks` };
  }
  return { allowed: true };
}

/**
 * Validate signal sender matches claimed role.
 * Prevents agents from impersonating other roles.
 */
export function validateSignalSender(
  claimedFrom: string,
  actualRole: string | undefined,
): ValidationResult {
  // If no actual role (e.g., user/system), skip
  if (!actualRole) return { allowed: true };

  if (claimedFrom !== actualRole) {
    return { allowed: false, reason: `Role mismatch: claimed ${claimedFrom} but agent is ${actualRole}` };
  }
  return { allowed: true };
}
