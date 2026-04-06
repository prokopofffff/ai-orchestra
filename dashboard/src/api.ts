import type { Project, Task, TaskComment, AgentSession, AuditEntry, Message, QueueStatus } from "./types";

const BASE = "/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path}: ${res.status}`);
  return res.json();
}

async function del(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE ${path}: ${res.status}`);
}

// Projects
export const fetchProjects = () => get<Project[]>("/projects");
export const createProject = (data: { name: string; repoUrl?: string; description?: string }) =>
  post<Project>("/projects", data);
export const updateProject = (id: string, data: Partial<Project>) =>
  patch<Project>(`/projects/${id}`, data);

// Tasks
export const fetchTasks = (projectId: string) => get<Task[]>(`/tasks?projectId=${projectId}`);
export const fetchTask = (id: string) => get<Task>(`/tasks/${id}`);
export const createTask = (data: Partial<Task> & { projectId: string; title: string }) =>
  post<Task>("/tasks", data);
export const updateTask = (id: string, data: Partial<Task>) => patch<Task>(`/tasks/${id}`, data);
export const deleteTask = (id: string) => del(`/tasks/${id}`);

// Comments
export const fetchComments = (taskId: string) => get<TaskComment[]>(`/tasks/${taskId}/comments`);
export const addComment = (taskId: string, author: string, body: string) =>
  post<TaskComment>(`/tasks/${taskId}/comments`, { author, body });

// Sessions
export const fetchSessions = (projectId?: string) =>
  get<AgentSession[]>(projectId ? `/sessions?projectId=${projectId}` : "/sessions");

// Signals / Audit
export const fetchAudit = (projectId: string, limit = 50) =>
  get<AuditEntry[]>(`/flow/audit?projectId=${projectId}&limit=${limit}`);

// Messages
export const fetchMessages = (projectId: string, limit = 50) =>
  get<Message[]>(`/conversations/${projectId}/messages?limit=${limit}`);
export const sendMessage = (projectId: string, text: string) =>
  post<Message>(`/conversations/${projectId}/messages`, { text });

// Queue
export const fetchQueueStatus = () => get<QueueStatus>("/queue/status");

// Usage
export interface UsageInfo {
  sessions: { total: number; running: number; completed: number; crashed: number };
  byRole: Record<string, { sessions: number; running: number }>;
  byModel: Record<string, number>;
  lastChecked: string;
}
export const fetchUsage = () => get<UsageInfo>("/usage");

// Health
export const fetchHealth = () => get<{ status: string; timestamp: string }>("/health");
