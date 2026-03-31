export interface AgentSession {
  id: string;
  role: string;
  projectId: string;
  claudeSessionId: string | null;
  createdAt: string;
  lastActiveAt: string;
  status: "running" | "sleeping" | "terminated";
  taskId: string | null;
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  from_agent: string;
  to_agent: string;
  action: string;
  task_id: string | null;
  allowed: boolean;
  reason: string | null;
  context: Record<string, unknown>;
}

export interface QueuedTask {
  id: string;
  role: string;
  projectId: string;
  taskId: string | null;
  prompt: string;
  priority: number;
  createdAt: string;
}

export interface HealthStatus {
  status: string;
  timestamp: string;
}

export interface Task {
  id: string;
  project_id: string;
  subject: string;
  description: string;
  type: string;
  priority: string;
  state: string;
  parent_id: string | null;
  assignee: string | null;
  done_ratio: number;
  created_at: string;
  updated_at: string;
}

export interface TaskComment {
  id: string;
  task_id: string;
  author: string;
  comment: string;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
}
