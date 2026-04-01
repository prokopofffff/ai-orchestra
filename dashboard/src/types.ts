export interface Project {
  id: string;
  name: string;
  slug: string;
  repoUrl: string | null;
  description: string | null;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  description: string | null;
  type: "epic" | "task" | "subtask" | "bug" | "feature";
  state: TaskState;
  priority: "low" | "normal" | "high" | "immediate";
  assigneeRole: string | null;
  blockedBy: string[];
  branchName: string | null;
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TaskState =
  | "new" | "described" | "designing" | "design_ready"
  | "in_development" | "pr_created" | "in_testing" | "tested"
  | "in_review" | "approved" | "merged" | "closed";

export interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface AgentSession {
  id: string;
  projectId: string;
  role: string;
  taskId: string | null;
  claudeSessionId: string | null;
  pid: number | null;
  status: "running" | "sleeping" | "terminated" | "crashed";
  model: string;
  worktreePath: string | null;
  lastHeartbeat: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface AuditEntry {
  id: string;
  projectId: string;
  fromRole: string;
  toRole: string;
  action: string;
  taskId: string | null;
  status: "allowed" | "rejected";
  reason: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  fromRole: "user" | "tech-lead" | "system";
  source: "telegram" | "dashboard";
  text: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface QueueStatus {
  rateLimited: boolean;
  rateLimitResetTime: string | null;
  queued: number;
  running: number;
  completed: number;
  failed: number;
}

export const KANBAN_PHASES = {
  Backlog: ["new", "described"],
  Design: ["designing", "design_ready"],
  Development: ["in_development", "pr_created"],
  Testing: ["in_testing", "tested"],
  Review: ["in_review", "approved"],
  Done: ["merged", "closed"],
} as const;

export const ROLE_COLORS: Record<string, string> = {
  "tech-lead": "#e74c3c",
  designer: "#9b59b6",
  frontend: "#3498db",
  backend: "#2ecc71",
  qa: "#f39c12",
  devops: "#1abc9c",
};
