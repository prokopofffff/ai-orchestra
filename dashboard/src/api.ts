import { z } from "zod";
import {
  ProjectSchema, TaskSchema, TaskCommentSchema, AgentSessionSchema,
  AuditEntrySchema, MessageSchema, QueueStatusSchema,
  type Project, type Task, type TaskComment, type AgentSession,
  type AuditEntry, type Message, type QueueStatus,
} from "@ai-orchestra/shared";

const BASE = "/api";

/**
 * Fetch helpers parse responses through the shared Zod schemas — runtime
 * validation, not just type assertion. Catches backend/frontend drift early
 * (returns a clear validation error instead of a silent undefined later).
 */
async function getValidated<T extends z.ZodTypeAny>(path: string, schema: T): Promise<z.infer<T>> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return schema.parse(await res.json());
}

async function postValidated<T extends z.ZodTypeAny>(path: string, body: unknown, schema: T): Promise<z.infer<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return schema.parse(await res.json());
}

async function patchValidated<T extends z.ZodTypeAny>(path: string, body: unknown, schema: T): Promise<z.infer<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path}: ${res.status}`);
  return schema.parse(await res.json());
}

async function del(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE ${path}: ${res.status}`);
}

// Projects
export const fetchProjects = (): Promise<Project[]> =>
  getValidated("/projects", z.array(ProjectSchema));
export const createProject = (data: { name: string; repoUrl?: string; localPath?: string; description?: string }): Promise<Project> =>
  postValidated("/projects", data, ProjectSchema);
export const updateProject = (id: string, data: Partial<Project> & { localPath?: string | null }): Promise<Project> =>
  patchValidated(`/projects/${id}`, data, ProjectSchema);

// System Config
const SystemConfigSchema = z.object({
  claude_auth: z.enum(["max", "api"]).optional(),
  claude_api_key: z.string().optional(),
  github_token: z.string().optional(),
  github_default_org: z.string().optional(),
  github_default_branch: z.string().optional(),
});
export type SystemConfig = z.infer<typeof SystemConfigSchema>;
export const fetchSystemConfig = (): Promise<SystemConfig> =>
  getValidated("/system-config", SystemConfigSchema);
export const updateSystemConfig = (data: SystemConfig): Promise<SystemConfig> =>
  patchValidated("/system-config", data, SystemConfigSchema);

// Tasks
export const fetchTasks = (projectId: string): Promise<Task[]> =>
  getValidated(`/tasks?projectId=${projectId}`, z.array(TaskSchema));
export const fetchTask = (id: string): Promise<Task> =>
  getValidated(`/tasks/${id}`, TaskSchema);
export const createTask = (data: Partial<Task> & { projectId: string; title: string }): Promise<Task> =>
  postValidated("/tasks", data, TaskSchema);
export const updateTask = (id: string, data: Partial<Task>): Promise<Task> =>
  patchValidated(`/tasks/${id}`, data, TaskSchema);
export const deleteTask = (id: string) => del(`/tasks/${id}`);

// Comments
export const fetchComments = (taskId: string): Promise<TaskComment[]> =>
  getValidated(`/tasks/${taskId}/comments`, z.array(TaskCommentSchema));
export const addComment = (taskId: string, author: string, body: string): Promise<TaskComment> =>
  postValidated(`/tasks/${taskId}/comments`, { author, body }, TaskCommentSchema);

// Sessions
export const fetchSessions = (projectId?: string): Promise<AgentSession[]> =>
  getValidated(
    projectId ? `/sessions?projectId=${projectId}` : "/sessions",
    z.array(AgentSessionSchema),
  );

// Signals / Audit
export const fetchAudit = (projectId: string, limit = 50): Promise<AuditEntry[]> =>
  getValidated(`/flow/audit?projectId=${projectId}&limit=${limit}`, z.array(AuditEntrySchema));

// Messages
export const fetchMessages = (projectId: string, limit = 50): Promise<Message[]> =>
  getValidated(`/conversations/${projectId}/messages?limit=${limit}`, z.array(MessageSchema));
export const sendMessage = (projectId: string, text: string): Promise<Message> =>
  postValidated(`/conversations/${projectId}/messages`, { text }, MessageSchema);

// Queue
export const fetchQueueStatus = (): Promise<QueueStatus> =>
  getValidated("/queue/status", QueueStatusSchema);

// Usage — local to dashboard (not in shared yet)
const UsageSchema = z.object({
  sessions: z.object({
    total: z.number(),
    running: z.number(),
    completed: z.number(),
    crashed: z.number(),
  }),
  byRole: z.record(z.object({ sessions: z.number(), running: z.number() })),
  byModel: z.record(z.number()),
  lastChecked: z.string(),
});
export type UsageInfo = z.infer<typeof UsageSchema>;
export const fetchUsage = (): Promise<UsageInfo> => getValidated("/usage", UsageSchema);

// Health
const HealthSchema = z.object({ status: z.string(), timestamp: z.string() });
export const fetchHealth = () => getValidated("/health", HealthSchema);
