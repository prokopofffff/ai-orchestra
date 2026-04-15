/**
 * Dashboard-side types are derived from `@ai-orchestra/shared` schemas so they
 * cannot drift from the backend. UI-only constants (KANBAN_PHASES, role color
 * tokens) live here.
 */

export type {
  AgentRole, TaskState, TaskType, TaskPriority,
  Project, ProjectSettings, Task, TaskComment,
  AgentSession, AuditEntry, Message, QueueStatus, AgentCheck,
} from "@ai-orchestra/shared";
export { AGENT_ROLES, TASK_STATES } from "@ai-orchestra/shared";

export const KANBAN_PHASES = {
  Backlog:     ["new", "described"],
  Design:      ["designing", "design_ready"],
  Development: ["in_development", "pr_created", "revisions"],
  Testing:     ["in_testing", "tested"],
  Review:      ["in_review", "approved"],
  Done:        ["merged", "closed"],
  Blocked:     ["failed", "cancelled"],
} as const;

/**
 * Role color tokens. Values are CSS var references so the palette lives in
 * styles.css (`:root --role-*`). Components pass these as-is to inline styles
 * or SVG `fill` attributes, both of which resolve `var(...)` at paint time.
 */
export const ROLE_COLORS: Record<string, string> = {
  "tech-lead": "var(--role-tech-lead)",
  designer:    "var(--role-designer)",
  frontend:    "var(--role-frontend)",
  backend:     "var(--role-backend)",
  qa:          "var(--role-qa)",
  devops:      "var(--role-devops)",
};

export const ROLE_FALLBACK = "var(--text-muted)";
