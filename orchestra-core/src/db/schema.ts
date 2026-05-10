/**
 * Drizzle schema — single source of truth for the orchestra-core tables.
 *
 * `drizzle-kit generate` diffs this file against the recorded snapshot to
 * produce migrations. New schema changes go here; the SQL ends up in
 * `drizzle/` automatically.
 *
 * The hand-written SQL files in `src/migrations/` are the historical record
 * of how the live DB got to its current shape and run on every boot
 * (idempotent — IF NOT EXISTS / IF EXISTS guards). Once we're past the
 * baseline window we can drop them.
 *
 * NOTE: graphile-worker owns its own `graphile_worker.*` schema, managed
 * by its runner. Not modeled here.
 */

import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, jsonb, timestamp, doublePrecision, integer,
  boolean, index, uniqueIndex, check,
} from "drizzle-orm/pg-core";

// ─── Projects ─────────────────────────────────────────────────────────────

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  repoUrl: text("repo_url"),
  localPath: text("local_path"),
  description: text("description"),
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  // FK to users(id) — backfill in migration 017 sets this to the first-
  // registered user for legacy projects. Non-null going forward via API.
  ownerId: uuid("owner_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("projects_slug_key").on(t.slug),
  index("idx_projects_owner_id").on(t.ownerId),
]);

export const projectMembers = pgTable("project_members", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(), // → users(id)
  role: text("role").notNull().default("editor"),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_project_members_user_id").on(t.userId),
  check("project_members_role_check", sql`role IN ('viewer','editor','admin')`),
]);

// ─── Tasks ────────────────────────────────────────────────────────────────

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  // Self-reference: declared via .references() inline once the column exists.
  parentId: uuid("parent_id"),
  title: text("title").notNull(),
  description: text("description"),
  type: text("type").notNull().default("task"),
  state: text("state").notNull().default("new"),
  priority: text("priority").notNull().default("normal"),
  assigneeRole: text("assignee_role"),
  blockedBy: uuid("blocked_by").array().notNull().default(sql`'{}'::uuid[]`),
  branchName: text("branch_name"),
  prUrl: text("pr_url"),
  // Non-NULL = dispatcher refuses to spawn for this task. Generic across
  // revisions/failed/budget caps so we don't proliferate booleans.
  frozenReason: text("frozen_reason"),
  revisionsCount: integer("revisions_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  signalsCount: integer("signals_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_tasks_project_id").on(t.projectId),
  index("idx_tasks_state").on(t.state),
  index("idx_tasks_assignee_role").on(t.assigneeRole),
  // Constraints mirror the historical SQL — kept here so drizzle-kit can
  // regenerate them and so the schema doc is honest about state values.
  check("tasks_type_check", sql`type IN ('epic','task','subtask','bug','feature')`),
  check("tasks_state_check", sql`state IN (
    'new','described','designing','design_ready',
    'in_development','pr_created','revisions',
    'in_testing','tested',
    'in_review','approved','merged','closed',
    'failed','cancelled'
  )`),
  check("tasks_priority_check", sql`priority IN ('low','normal','high','immediate')`),
  check("tasks_assignee_role_check", sql`assignee_role IS NULL OR assignee_role IN ('tech-lead','designer','frontend','backend','qa','devops')`),
]);

// ─── Task comments ────────────────────────────────────────────────────────

export const taskComments = pgTable("task_comments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  author: text("author").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_task_comments_task_id").on(t.taskId),
]);

// ─── Sessions ─────────────────────────────────────────────────────────────

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  claudeSessionId: text("claude_session_id"),
  // pid column was dropped in migration 012 — agents run in-process via SDK.
  status: text("status").notNull().default("running"),
  model: text("model").notNull().default("sonnet"),
  worktreePath: text("worktree_path"),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  index("idx_sessions_project_id").on(t.projectId),
  index("idx_sessions_status").on(t.status),
  check("sessions_role_check", sql`role IN ('tech-lead','designer','frontend','backend','qa','devops')`),
  check("sessions_status_check", sql`status IN ('running','sleeping','terminated','crashed')`),
]);

// ─── Signals ──────────────────────────────────────────────────────────────

export const signals = pgTable("signals", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  fromRole: text("from_role").notNull(),
  toRole: text("to_role").notNull(),
  action: text("action").notNull(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_signals_project_id").on(t.projectId),
  index("idx_signals_to_role").on(t.toRole),
  index("idx_signals_read").on(t.read),
]);

// ─── Conversations + messages ─────────────────────────────────────────────

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id").notNull().unique().references(() => projects.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  fromRole: text("from_role").notNull(),
  source: text("source").notNull().default("dashboard"),
  text: text("text").notNull(),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_messages_conversation_id").on(t.conversationId),
  index("idx_messages_created_at").on(t.createdAt),
  check("messages_from_role_check", sql`from_role IN ('user','tech-lead','system')`),
  check("messages_source_check", sql`source IN ('telegram','dashboard')`),
]);

export const telegramUsers = pgTable("telegram_users", {
  chatId: text("chat_id").primaryKey(),
  activeProjectId: uuid("active_project_id").references(() => projects.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Flow audit ───────────────────────────────────────────────────────────

export const flowAudit = pgTable("flow_audit", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  fromRole: text("from_role").notNull(),
  toRole: text("to_role").notNull(),
  action: text("action").notNull(),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  status: text("status").notNull(),
  reason: text("reason"),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_flow_audit_project_id").on(t.projectId),
  index("idx_flow_audit_status").on(t.status),
  index("idx_flow_audit_created_at").on(t.createdAt),
  check("flow_audit_status_check", sql`status IN ('allowed','rejected')`),
]);

// ─── Agent logs ───────────────────────────────────────────────────────────

export const agentLogs = pgTable("agent_logs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
  role: text("role").notNull(),
  level: text("level").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_agent_logs_project_id").on(t.projectId),
  index("idx_agent_logs_session_id").on(t.sessionId),
  index("idx_agent_logs_created_at").on(t.createdAt),
  check("agent_logs_level_check", sql`level IN ('stdout','stderr','system','error')`),
]);

// ─── Usage costs (per-run, per-model spend telemetry) ─────────────────────

export const usageCosts = pgTable("usage_costs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  role: text("role").notNull(),
  model: text("model").notNull(),
  costUsd: doublePrecision("cost_usd").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  resultSubtype: text("result_subtype"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_usage_costs_project_day").on(t.projectId, t.createdAt),
  index("idx_usage_costs_session").on(t.sessionId),
  index("idx_usage_costs_task").on(t.taskId),
]);

// ─── Rate buckets (token-bucket gating for the scheduler) ─────────────────

export const rateBuckets = pgTable("rate_buckets", {
  key: text("key").primaryKey(),
  tokens: doublePrecision("tokens").notNull(),
  capacity: doublePrecision("capacity").notNull(),
  refillRate: doublePrecision("refill_rate").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Inferred row types ───────────────────────────────────────────────────
//
// Use these in app code instead of hand-typing SELECT row shapes:
//   import type { Project, NewProject } from "./db/schema";

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskComment = typeof taskComments.$inferSelect;
export type NewTaskComment = typeof taskComments.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Signal = typeof signals.$inferSelect;
export type NewSignal = typeof signals.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type TelegramUser = typeof telegramUsers.$inferSelect;
export type FlowAudit = typeof flowAudit.$inferSelect;
export type AgentLog = typeof agentLogs.$inferSelect;
export type RateBucket = typeof rateBuckets.$inferSelect;
export type UsageCost = typeof usageCosts.$inferSelect;
export type NewUsageCost = typeof usageCosts.$inferInsert;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type NewProjectMember = typeof projectMembers.$inferInsert;
