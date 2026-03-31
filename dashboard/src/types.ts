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
