/**
 * Shared schemas — single source of truth for cross-cutting types.
 *
 * Backend uses these for request/response validation; dashboard derives
 * its TS types via `z.infer` so the two can't drift.
 */

import { z } from "zod";

// ─── Enums ─────────────────────────────────────────────────────────────────

export const AgentRoleSchema = z.enum([
  "tech-lead", "designer", "frontend", "backend", "qa", "devops",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const TaskStateSchema = z.enum([
  "new", "described", "designing", "design_ready",
  "in_development", "pr_created", "revisions",
  "in_testing", "tested",
  "in_review", "approved", "merged", "closed",
  "failed", "cancelled",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskTypeSchema = z.enum(["epic", "task", "subtask", "bug", "feature"]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const TaskPrioritySchema = z.enum(["low", "normal", "high", "immediate"]);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const SessionStatusSchema = z.enum(["running", "sleeping", "terminated", "crashed"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const MessageRoleSchema = z.enum(["user", "tech-lead", "system"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageSourceSchema = z.enum(["telegram", "dashboard"]);
export type MessageSource = z.infer<typeof MessageSourceSchema>;

// ─── Domain shapes ─────────────────────────────────────────────────────────

export const AgentCheckSchema = z.object({
  name: z.string(),
  pattern: z.string(),
  command: z.string(),
  onFail: z.enum(["warn", "alert"]),
});
export type AgentCheck = z.infer<typeof AgentCheckSchema>;

export const GitProviderKindSchema = z.enum(["github", "gitlab"]);
export type GitProviderKind = z.infer<typeof GitProviderKindSchema>;

/**
 * Per-project git provider configuration. If `type` is absent the provider
 * is auto-detected from the repo URL hostname; if `token` is absent the
 * matching global env token is used (GITHUB_TOKEN / GITLAB_TOKEN).
 * `baseUrl` is for self-hosted instances (e.g. `https://gitlab.internal`).
 */
export const ProjectProviderConfigSchema = z.object({
  type: GitProviderKindSchema.optional(),
  token: z.string().optional(),
  baseUrl: z.string().optional(),
});
export type ProjectProviderConfig = z.infer<typeof ProjectProviderConfigSchema>;

/**
 * Per-project safety limits. `dailyCostUsd = 0` means unlimited; absence of
 * any field means "use the in-code default". Numeric defaults live in
 * orchestra-core/src/config.ts → `DEFAULT_LIMITS` so they can change without
 * touching the wire schema.
 */
export const LimitsSchema = z.object({
  dailyCostUsd: z.number().nonnegative().optional(),
  perRunBudgetUsd: z.record(AgentRoleSchema, z.number().positive()).optional(),
  maxRevisions: z.number().int().positive().optional(),
  maxFails: z.number().int().positive().optional(),
  maxSignalsPerTask: z.number().int().positive().optional(),
  maxQaDepth: z.number().int().positive().optional(),
  maxConcurrentSessions: z.number().int().positive().optional(),
  /** Per-task cost-per-hour ceiling. Trips a freeze + escalate. */
  taskHourlyCostUsd: z.number().nonnegative().optional(),
  runTimeoutMs: z.record(AgentRoleSchema, z.number().int().positive()).optional(),
});
export type Limits = z.infer<typeof LimitsSchema>;

/** SDK effort levels. `max` is Opus-only. */
export const EffortLevelSchema = z.enum(["low", "medium", "high", "max"]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

/**
 * Per-project Telegram bot configuration. `botToken` from BotFather,
 * `chatId` auto-captured on the first /start the bot receives. A given
 * `botToken` may belong to at most one project (enforced both at the
 * API and via a partial unique index in migration 022).
 */
export const TelegramConfigSchema = z.object({
  botToken: z.string().min(1).optional(),
  chatId: z.string().min(1).optional(),
});
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;

export const ProjectSettingsSchema = z.object({
  models: z.record(AgentRoleSchema, z.string()).optional(),
  effort: z.record(AgentRoleSchema, EffortLevelSchema).optional(),
  checks: z.record(AgentRoleSchema, z.array(AgentCheckSchema)).optional(),
  provider: ProjectProviderConfigSchema.optional(),
  limits: LimitsSchema.optional(),
  telegram: TelegramConfigSchema.optional(),
}).catchall(z.unknown());
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  repoUrl: z.string().nullable(),
  localPath: z.string().nullable(),
  description: z.string().nullable(),
  settings: z.record(z.unknown()), // looser at the boundary; ProjectSettings parses it strictly
  ownerId: z.string().uuid().nullable().optional(),
  introTaskId: z.string().uuid().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const TaskSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  type: TaskTypeSchema,
  state: TaskStateSchema,
  priority: TaskPrioritySchema,
  assigneeRole: z.string().nullable(),
  blockedBy: z.array(z.string().uuid()),
  branchName: z.string().nullable(),
  prUrl: z.string().nullable(),
  frozenReason: z.string().nullable().optional(),
  revisionsCount: z.number().int().nonnegative().optional(),
  failedCount: z.number().int().nonnegative().optional(),
  signalsCount: z.number().int().nonnegative().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskCommentSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  author: z.string(),
  body: z.string(),
  createdAt: z.coerce.date(),
});
export type TaskComment = z.infer<typeof TaskCommentSchema>;

export const AgentSessionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  role: AgentRoleSchema,
  taskId: z.string().uuid().nullable(),
  claudeSessionId: z.string().nullable(),
  status: SessionStatusSchema,
  model: z.string(),
  worktreePath: z.string().nullable(),
  lastHeartbeat: z.coerce.date().nullable(),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().nullable(),
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const AuditEntrySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  fromRole: z.string(),
  toRole: z.string(),
  action: z.string(),
  taskId: z.string().uuid().nullable(),
  status: z.enum(["allowed", "rejected"]),
  reason: z.string().nullable(),
  payload: z.record(z.unknown()),
  createdAt: z.coerce.date(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const MessageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  fromRole: MessageRoleSchema,
  source: MessageSourceSchema,
  text: z.string(),
  metadata: z.record(z.unknown()),
  createdAt: z.coerce.date(),
});
export type Message = z.infer<typeof MessageSchema>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  username: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type User = z.infer<typeof UserSchema>;

export const SignupSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, "Letters, digits and underscores only"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});
export type SignupRequest = z.infer<typeof SignupSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const QueueStatusSchema = z.object({
  rateLimited: z.boolean(),
  rateLimitResetTime: z.string().nullable(),
  queued: z.number().int(),
  running: z.number().int(),
  completed: z.number().int(),
  failed: z.number().int(),
});
export type QueueStatus = z.infer<typeof QueueStatusSchema>;

// ─── Useful constants (kept here so dashboard can render UI without backend) ──

export const AGENT_ROLES = AgentRoleSchema.options;
export const TASK_STATES = TaskStateSchema.options;
export const TASK_TYPES = TaskTypeSchema.options;
export const TASK_PRIORITIES = TaskPrioritySchema.options;

// ─── Domain flow (single source of truth for routing/validation/viz) ───────

export * from "./flow";
export * from "./flow-mermaid";
