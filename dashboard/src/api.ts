import { z } from "zod";
import {
  ProjectSchema, TaskSchema, TaskCommentSchema, AgentSessionSchema,
  AuditEntrySchema, MessageSchema, QueueStatusSchema, UserSchema,
  type Project, type Task, type TaskComment, type AgentSession,
  type AuditEntry, type Message, type QueueStatus, type User,
} from "@ai-orchestra/shared";

export class AuthError extends Error {
  constructor() {
    super("Unauthorized");
  }
}

const BASE = "/api";

/**
 * Fetch helpers parse responses through the shared Zod schemas — runtime
 * validation, not just type assertion. Catches backend/frontend drift early
 * (returns a clear validation error instead of a silent undefined later).
 */
async function getValidated<T extends z.ZodTypeAny>(path: string, schema: T): Promise<z.infer<T>> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include" });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return schema.parse(await res.json());
}

async function postValidated<T extends z.ZodTypeAny>(path: string, body: unknown, schema: T): Promise<z.infer<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return schema.parse(await res.json());
}

async function patchValidated<T extends z.ZodTypeAny>(path: string, body: unknown, schema: T): Promise<z.infer<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path}: ${res.status}`);
  return schema.parse(await res.json());
}

async function del(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE", credentials: "include" });
  if (!res.ok) throw new Error(`DELETE ${path}: ${res.status}`);
}

// Auth
export const fetchMe = (): Promise<User> => getValidated("/auth/me", UserSchema);
export const login = (data: { email: string; password: string }): Promise<User> =>
  postValidated("/auth/login", data, UserSchema);
export const signup = (data: { email: string; username: string; password: string }): Promise<User> =>
  postValidated("/auth/signup", data, UserSchema);
export const logout = async (): Promise<void> => {
  await fetch(`${BASE}/auth/logout`, { method: "POST", credentials: "include" });
};

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
  orchestra_daily_cost_cap_usd: z.string().optional(),
});
export type SystemConfig = z.infer<typeof SystemConfigSchema>;
export const fetchSystemConfig = (): Promise<SystemConfig> =>
  getValidated("/system-config", SystemConfigSchema);
export const updateSystemConfig = (data: SystemConfig): Promise<SystemConfig> =>
  patchValidated("/system-config", data, SystemConfigSchema);

// Project notes (intro_summary, future kinds)
const ProjectNoteSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  kind: z.string(),
  body: z.string(),
  author: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ProjectNote = z.infer<typeof ProjectNoteSchema>;
export const fetchProjectNotes = (projectId: string): Promise<ProjectNote[]> =>
  getValidated(`/projects/${projectId}/notes`, z.array(ProjectNoteSchema));

const RescanSchema = z.object({ introTaskId: z.string().uuid() });
export const rescanProject = (projectId: string) =>
  postValidated(`/projects/${projectId}/rescan`, {}, RescanSchema);

const RepoStatusSchema = z.object({
  localPath: z.string().nullable(),
  hasRemoteUrl: z.boolean(),
  exists: z.boolean(),
  isGitRepo: z.boolean(),
  needsInit: z.boolean(),
});
export type RepoStatus = z.infer<typeof RepoStatusSchema>;
export const fetchRepoStatus = (projectId: string): Promise<RepoStatus> =>
  getValidated(`/projects/${projectId}/repo-status`, RepoStatusSchema);

const InitGitSchema = z.object({ initialized: z.boolean(), path: z.string() });
export const initProjectGit = (projectId: string) =>
  postValidated(`/projects/${projectId}/init-git`, {}, InitGitSchema);

// Members
const MemberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  username: z.string(),
  role: z.enum(["owner", "viewer", "editor", "admin"]),
  addedAt: z.coerce.date().optional().nullable(),
});
export type ProjectMember = z.infer<typeof MemberSchema>;

const MembersListSchema = z.object({
  owner: MemberSchema.nullable(),
  members: z.array(MemberSchema),
});
export type ProjectMembersList = z.infer<typeof MembersListSchema>;

export const fetchProjectMembers = (projectId: string): Promise<ProjectMembersList> =>
  getValidated(`/projects/${projectId}/members`, MembersListSchema);

export const inviteProjectMember = (
  projectId: string,
  identifier: string,
  role: "viewer" | "editor" | "admin",
): Promise<ProjectMember> =>
  postValidated(`/projects/${projectId}/members`, { identifier, role }, MemberSchema);

export const removeProjectMember = (projectId: string, userId: string): Promise<void> =>
  del(`/projects/${projectId}/members/${userId}`);

export const updateProjectMemberRole = (
  projectId: string,
  userId: string,
  role: "viewer" | "editor" | "admin",
): Promise<ProjectMember> =>
  patchValidated(`/projects/${projectId}/members/${userId}`, { role }, MemberSchema);

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
export const unfreezeTask = (id: string): Promise<Task> =>
  postValidated(`/tasks/${id}/unfreeze`, {}, TaskSchema);

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

// Live activity ("TL is thinking...") for the chat
const ChatActivitySchema = z.object({
  active: z.boolean(),
  sessionId: z.string().uuid().nullable(),
  latestActivity: z.string().nullable(),
  sinceMs: z.number(),
});
export type ChatActivity = z.infer<typeof ChatActivitySchema>;
export const fetchChatActivity = (projectId: string): Promise<ChatActivity> =>
  getValidated(`/conversations/${projectId}/activity`, ChatActivitySchema);

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

// Cost — per-project 24h spend with breakdown + configured cap.
const UsageTodaySchema = z.object({
  total: z.number(),
  cap: z.number(),
  byRole: z.record(z.number()),
  byModel: z.record(z.number()),
});
export type UsageToday = z.infer<typeof UsageTodaySchema>;
export const fetchUsageToday = (projectId: string): Promise<UsageToday> =>
  getValidated(`/usage/today?projectId=${projectId}`, UsageTodaySchema);

const UsageCostsSchema = z.object({
  total: z.number(),
  rows: z.array(z.object({
    projectId: z.string(),
    role: z.string(),
    model: z.string(),
    total: z.number(),
  })),
});
export const fetchUsageCosts = (params: { projectId?: string; from?: string; to?: string }) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const q = qs.toString();
  return getValidated(`/usage/costs${q ? `?${q}` : ""}`, UsageCostsSchema);
};

const UsageSeriesSchema = z.object({
  days: z.array(z.object({
    day: z.string(),
    total: z.number(),
    byRole: z.record(z.number()),
    byModel: z.record(z.number()),
  })),
});
export type UsageSeries = z.infer<typeof UsageSeriesSchema>;
export const fetchUsageSeries = (projectId: string, days: 7 | 30 = 7): Promise<UsageSeries> =>
  getValidated(`/usage/costs/series?projectId=${projectId}&days=${days}`, UsageSeriesSchema);

// Health
const HealthSchema = z.object({ status: z.string(), timestamp: z.string() });
export const fetchHealth = () => getValidated("/health", HealthSchema);

// Server-side filesystem browse (for the folder picker on Create Project).
const FsEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDir: z.literal(true),
  isGitRepo: z.boolean(),
});
const FsBrowseSchema = z.object({
  cwd: z.string(),
  parent: z.string().nullable(),
  home: z.string(),
  entries: z.array(FsEntrySchema),
});
export type FsBrowseResult = z.infer<typeof FsBrowseSchema>;
export const browseFs = (path?: string, showHidden = false): Promise<FsBrowseResult> => {
  const qs = new URLSearchParams();
  if (path) qs.set("path", path);
  if (showHidden) qs.set("showHidden", "true");
  const q = qs.toString();
  return getValidated(`/fs/browse${q ? `?${q}` : ""}`, FsBrowseSchema);
};

// Onboarding
const OnboardingStepSchema = z.object({
  key: z.enum(["claude_auth", "project", "git_token", "telegram"]),
  title: z.string(),
  done: z.boolean(),
  href: z.string(),
  hint: z.string().optional(),
  optional: z.boolean().optional(),
});
const TabKeySchema = z.enum([
  "kanban", "chat", "signals", "agents", "flow", "logs", "settings", "profile",
]);
export type OnboardingTabKey = z.infer<typeof TabKeySchema>;

const OnboardingSchema = z.object({
  dismissedAt: z.string().nullable(),
  welcomeSeenAt: z.string().nullable(),
  showWelcome: z.boolean(),
  allDone: z.boolean(),
  steps: z.array(OnboardingStepSchema),
  tabsSeen: z.array(TabKeySchema),
});
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;
export type OnboardingState = z.infer<typeof OnboardingSchema>;
export const fetchOnboarding = (): Promise<OnboardingState> =>
  getValidated("/onboarding", OnboardingSchema);
export const dismissOnboarding = (): Promise<OnboardingState> =>
  postValidated("/onboarding/dismiss", {}, OnboardingSchema);
export const markWelcomeSeen = (): Promise<OnboardingState> =>
  postValidated("/onboarding/welcome-seen", {}, OnboardingSchema);
export const markTabSeen = (key: OnboardingTabKey): Promise<OnboardingState> =>
  postValidated(`/onboarding/tabs/${key}`, {}, OnboardingSchema);
