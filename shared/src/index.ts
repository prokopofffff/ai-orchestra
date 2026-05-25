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
 * is auto-detected from the repo URL hostname. `baseUrl` is for self-hosted
 * instances (e.g. `https://gitlab.internal`).
 *
 * Token storage: `tokenEncrypted` holds base64 AES-GCM ciphertext at rest.
 * The plaintext `token` field is wire-format only — accepted on PATCH from
 * the dashboard, never persisted as-is (orchestra-core re-shapes it into
 * tokenEncrypted before insert). On read, project-secrets.getProjectGitToken
 * decrypts on demand. No env-var fallback — see providers/resolver.ts.
 */
export const ProjectProviderConfigSchema = z.object({
  type: GitProviderKindSchema.optional(),
  token: z.string().optional(),
  tokenEncrypted: z.string().optional(),
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

/**
 * Per-project Claude credentials. `auth` chooses the auth mode for THIS
 * project; `max` runs against the per-project Claude credentials dir
 * (data/project-creds/&lt;id&gt;/.claude/, populated by `claude /login`); `api`
 * uses the persisted `apiKey`. The orchestra-wide system_config default
 * still applies as a fallback for `auth` mode selection, but credentials
 * are now strictly per-project — there is no env-var fallback (the
 * pre-refactor model leaked across users).
 */
export const ProjectClaudeConfigSchema = z.object({
  auth: z.enum(["max", "api"]).optional(),
  // Wire-format only: a plaintext apiKey on PATCH gets encrypted and
  // re-stored under apiKeyEncrypted before reaching the DB. See
  // project-secrets.normalizeProjectSecretsForWrite. Reads go through
  // project-secrets.getProjectClaudeApiKey (decrypt on demand).
  apiKey: z.string().optional(),
  apiKeyEncrypted: z.string().optional(),
});
export type ProjectClaudeConfig = z.infer<typeof ProjectClaudeConfigSchema>;

/**
 * Per-project Codex (OpenAI) credentials. Same shape as Claude: `auth` picks
 * the mode; `subscription` (ChatGPT Plus/Pro/Codex) reads credentials from
 * data/project-creds/&lt;id&gt;/.codex/auth.json (populated by `codex login`);
 * `api` uses the persisted `apiKey`. Persistence happens via
 * `codex login --with-api-key` even in api mode — codex does not honour the
 * OPENAI_API_KEY env var at request time (empirically verified).
 */
export const ProjectCodexConfigSchema = z.object({
  auth: z.enum(["subscription", "api"]).optional(),
  // Wire-format only — same lifecycle as ProjectClaudeConfig.apiKey.
  apiKey: z.string().optional(),
  apiKeyEncrypted: z.string().optional(),
});
export type ProjectCodexConfig = z.infer<typeof ProjectCodexConfigSchema>;

/**
 * Per-role model spec. Accepts both:
 *   - bare model name (`"opus"`, `"sonnet"`, `"haiku"`) — defaults to claude
 *     for backward compatibility with pre-codex projects
 *   - `provider:model` (`"claude:opus"`, `"codex:gpt-5-codex"`) — explicit
 *
 * Provider-aware code calls `parseModelSpec()` to resolve.
 */
export const ModelSpecSchema = z.string().min(1);

export type RuntimeProvider = "claude" | "codex";

export type ParsedModelSpec = {
  provider: RuntimeProvider;
  model: string;
};

/**
 * Parse a per-role model setting. Bare names assume claude (backward compat).
 * Unknown providers fall back to claude rather than throwing — keeps a
 * misconfigured project running rather than crashing the spawn cycle.
 */
export function parseModelSpec(spec: string): ParsedModelSpec {
  const idx = spec.indexOf(":");
  if (idx <= 0) return { provider: "claude", model: spec };
  const provider = spec.slice(0, idx) as RuntimeProvider;
  const model = spec.slice(idx + 1);
  if (provider !== "claude" && provider !== "codex") {
    return { provider: "claude", model: spec };
  }
  return { provider, model };
}

export const ProjectSettingsSchema = z.object({
  models: z.record(AgentRoleSchema, ModelSpecSchema).optional(),
  effort: z.record(AgentRoleSchema, EffortLevelSchema).optional(),
  checks: z.record(AgentRoleSchema, z.array(AgentCheckSchema)).optional(),
  provider: ProjectProviderConfigSchema.optional(),
  limits: LimitsSchema.optional(),
  telegram: TelegramConfigSchema.optional(),
  claude: ProjectClaudeConfigSchema.optional(),
  codex: ProjectCodexConfigSchema.optional(),
  /**
   * If true, an approved PR (signal `pr_approved` from tech-lead) is merged
   * automatically by orchestra-core. If false (default), the user gets a
   * notification and merges manually via the provider's UI.
   */
  autoMerge: z.boolean().optional(),
  /**
   * Other project IDs the agents in this project may read for context (e.g.
   * "build a new app following the conventions of projects X and Y"). The
   * bootstrap prompt lists their absolute workspace paths so the agent can
   * grep / read them via the normal Read tool; writes outside the agent's
   * own workspace are still disallowed by the system prompt and (where
   * configured) by sandbox/scope-hook layers.
   *
   * Linkage is validated at PATCH time — the caller must have access to
   * every referenced project. Revocations are re-checked at each spawn:
   * inaccessible refs are silently dropped and a system message is posted
   * so the user notices the link is dead.
   */
  referenceProjects: z.array(z.string().uuid()).optional(),
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
