import type { AgentSession, AuditEntry, QueuedTask, HealthStatus, Task, TaskComment, Project } from "./types";

const BASE = "/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || res.statusText);
  }
  return res.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  sessions: () => get<AgentSession[]>("/sessions"),
  audit: (limit = 50) => get<AuditEntry[]>(`/flow/audit?limit=${limit}`),
  violations: (limit = 50) => get<AuditEntry[]>(`/flow/violations?limit=${limit}`),
  queue: () => get<QueuedTask[]>("/queue"),
  health: () => get<HealthStatus>("/health"),

  projects: () => get<Project[]>("/projects"),
  createProject: (name: string, description?: string) =>
    post<Project>("/projects", { name, description }),

  tasks: (projectId?: string) =>
    get<Task[]>(projectId ? `/tasks?project=${projectId}` : "/tasks"),
  task: (id: string) => get<Task>(`/tasks/${id}`),
  createTask: (data: {
    projectId: string;
    subject: string;
    description?: string;
    type?: string;
    priority?: string;
    parentId?: string;
    assignee?: string;
  }) => post<Task>("/tasks", data),
  updateTask: (id: string, data: Record<string, unknown>) =>
    patch<Task>(`/tasks/${id}`, data),

  comments: (taskId: string) => get<TaskComment[]>(`/tasks/${taskId}/comments`),
  addComment: (taskId: string, author: string, comment: string) =>
    post<{ id: string }>(`/tasks/${taskId}/comments`, { author, comment }),
};
