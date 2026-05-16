import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ProjectSchema, TaskSchema, TaskCommentSchema } from "@ai-orchestra/shared";
import { getDb, getPool } from "./db";
import { projects, tasks, taskComments, conversations, projectNotes } from "./db/schema";
import { parseRow, parseRows } from "./db-utils";
import { checkUnblocked } from "./dependency-engine";
import { canCreateTask, canUpdateTask, canDeleteTask } from "./agent-auth";
import { currentUserId } from "./auth";
import {
  userCanAccessProject, userCanEditProject,
  visibilityFilter, visibleProjectIds, projectIdOf,
} from "./project-access";
import { createIntroTask } from "./intro-task";
import { reconcileTelegramNow } from "./telegram-manager";
import { isGitRepo, initGitRepo } from "./repo-manager";
import { loadConfig } from "./config";
import type { AgentRole } from "./config";

/**
 * Reject a settings patch that would make this project share a Telegram
 * bot token with another project. Returns the conflicting project name
 * for a friendlier error message; null if there's no conflict.
 */
async function findTelegramConflict(
  newToken: string | undefined,
  excludeProjectId?: string,
): Promise<string | null> {
  if (!newToken) return null;
  const db = getDb();
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(sql`${projects.settings} -> 'telegram' ->> 'botToken' = ${newToken}`);
  const conflict = rows.find((r) => r.id !== excludeProjectId);
  return conflict ? conflict.name : null;
}

const projectSchema = ProjectSchema;
const taskSchema = TaskSchema;
const commentSchema = TaskCommentSchema;

export const taskPlugin: FastifyPluginAsync = async (app) => {
  // ─── Projects ───

  app.get("/projects", async (request) => {
    const userId = currentUserId(request);
    const db = getDb();
    const rows = await db
      .select()
      .from(projects)
      .where(visibilityFilter(userId))
      .orderBy(desc(projects.createdAt));
    return parseRows(projectSchema, rows);
  });

  app.post("/projects", async (request, reply) => {
    const userId = currentUserId(request);
    const body = z.object({
      name: z.string().min(1),
      slug: z.string().min(1).optional(),
      repoUrl: z.string().optional(),
      localPath: z.string().optional(),
      description: z.string().optional(),
    }).parse(request.body);

    const slug = body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const db = getDb();
    const [row] = await db.insert(projects).values({
      name: body.name,
      slug,
      repoUrl: body.repoUrl ?? null,
      localPath: body.localPath ?? null,
      description: body.description ?? null,
      ownerId: userId,
    }).returning();
    await db.insert(conversations).values({ projectId: row.id });

    // Auto-seed an "introduce yourself to this codebase" task. Only when
    // there's actually a repo to look at — a project with neither
    // local_path nor repo_url can't have anything indexed yet.
    if (row.repoUrl || row.localPath) {
      try {
        const introTaskId = await createIntroTask(row.id);
        await db
          .update(projects)
          .set({ introTaskId })
          .where(eq(projects.id, row.id));
        row.introTaskId = introTaskId;
      } catch (err) {
        // Best-effort: don't fail project creation if the intro task can't
        // be queued (e.g. flow_audit constraint). User can re-trigger from
        // Settings later.
        // eslint-disable-next-line no-console
        console.error("intro-task seeding failed", err);
      }
    }

    return reply.code(201).send(parseRow(projectSchema, row));
  });

  app.get<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    const userId = currentUserId(request);
    if (!(await userCanAccessProject(userId, request.params.id))) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const db = getDb();
    const [row] = await db.select().from(projects).where(eq(projects.id, request.params.id)).limit(1);
    if (!row) return reply.code(404).send({ error: "Project not found" });
    return parseRow(projectSchema, row);
  });

  app.patch<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    const userId = currentUserId(request);
    if (!(await userCanEditProject(userId, request.params.id))) {
      return reply.code(403).send({ error: "Insufficient permissions" });
    }
    const body = z.object({
      name: z.string().optional(),
      repoUrl: z.string().nullable().optional(),
      localPath: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      settings: z.record(z.unknown()).optional(),
    }).parse(request.body);

    // Telegram bot tokens have to be unique across projects — one bot can
    // long-poll for exactly one listener, so two projects with the same
    // token would lose half their updates each. Reject with 409 before
    // hitting the partial unique index (better error message).
    if (body.settings) {
      const newTg = (body.settings.telegram as { botToken?: string } | undefined)?.botToken;
      if (newTg) {
        const conflictName = await findTelegramConflict(newTg, request.params.id);
        if (conflictName) {
          return reply.code(409).send({
            error: `Bot token already in use by project "${conflictName}". Each project needs its own Telegram bot.`,
          });
        }
      }
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.repoUrl !== undefined) updates.repoUrl = body.repoUrl;
    if (body.localPath !== undefined) updates.localPath = body.localPath;
    if (body.description !== undefined) updates.description = body.description;
    // settings merges via jsonb concat — drizzle's set() doesn't have a direct
    // operator for `||`, so reach for `sql` here. Still typed at the column.
    if (body.settings !== undefined) {
      updates.settings = sql`${projects.settings} || ${JSON.stringify(body.settings)}::jsonb`;
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: "No fields to update" });
    }
    updates.updatedAt = sql`now()`;

    const db = getDb();
    const [row] = await db
      .update(projects)
      .set(updates)
      .where(eq(projects.id, request.params.id))
      .returning();
    if (!row) return reply.code(404).send({ error: "Project not found" });
    // If the patch touched telegram settings, kick the manager so it
    // starts / stops / restarts loops without waiting for the 30s timer.
    if (body.settings && (body.settings as { telegram?: unknown }).telegram !== undefined) {
      reconcileTelegramNow().catch(() => { /* best-effort */ });
    }
    return parseRow(projectSchema, row);
  });

  // ─── Project notes ───
  //
  // Project-level memory the orchestrator accumulates over time. First and
  // canonical inhabitant: `intro_summary` written by Tech Lead after the
  // initial scan of the codebase.

  app.get<{ Params: { id: string } }>("/projects/:id/notes", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.params.id;
    if (!(await userCanAccessProject(userId, projectId))) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const rows = await getDb()
      .select()
      .from(projectNotes)
      .where(eq(projectNotes.projectId, projectId))
      .orderBy(desc(projectNotes.createdAt));
    return rows;
  });

  // Re-trigger the intro task: queues a fresh one so TL re-scans the
  // codebase. Useful when the project has changed dramatically since the
  // first scan. Edit-permission required because it spends budget.
  app.post<{ Params: { id: string } }>("/projects/:id/rescan", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.params.id;
    if (!(await userCanEditProject(userId, projectId))) {
      return reply.code(403).send({ error: "Insufficient permissions" });
    }
    const introTaskId = await createIntroTask(projectId);
    await getDb()
      .update(projects)
      .set({ introTaskId })
      .where(eq(projects.id, projectId));
    return { introTaskId };
  });

  // ─── Local path status + init helpers ───
  //
  // The dashboard surfaces this so the user can tell at a glance whether
  // the project's local path is a git repo we can actually operate in.
  // Pairs with POST /projects/:id/init-git for one-click setup.

  app.get<{ Params: { id: string } }>("/projects/:id/repo-status", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.params.id;
    if (!(await userCanAccessProject(userId, projectId))) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const [row] = await getDb()
      .select({ localPath: projects.localPath, repoUrl: projects.repoUrl })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "Project not found" });

    const localPath = row.localPath ?? null;
    let exists = false;
    let isGit = false;
    if (localPath) {
      const fs = await import("node:fs");
      exists = fs.existsSync(localPath);
      if (exists) isGit = isGitRepo(localPath);
    }
    return {
      localPath,
      hasRemoteUrl: !!row.repoUrl,
      exists,
      isGitRepo: isGit,
      needsInit: !!localPath && exists && !isGit,
    };
  });

  app.post<{ Params: { id: string } }>("/projects/:id/init-git", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.params.id;
    if (!(await userCanEditProject(userId, projectId))) {
      return reply.code(403).send({ error: "Insufficient permissions" });
    }

    const [row] = await getDb()
      .select({ localPath: projects.localPath })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row?.localPath) {
      return reply.code(400).send({ error: "Project has no local path to initialize." });
    }

    try {
      await initGitRepo(row.localPath, loadConfig().githubDefaultBranch);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
    return { initialized: true, path: row.localPath };
  });

  app.delete<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    const userId = currentUserId(request);
    const db = getDb();
    const [row] = await db.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, request.params.id)).limit(1);
    if (!row) return reply.code(404).send({ error: "Project not found" });
    if (row.ownerId !== userId) {
      return reply.code(403).send({ error: "Only the project owner can delete it" });
    }
    await db.delete(projects).where(eq(projects.id, request.params.id));
    return { deleted: true };
  });

  // ─── Tasks ───

  app.get("/tasks", async (request, reply) => {
    const userId = currentUserId(request);
    const query = request.query as Record<string, string>;
    const filters = z.object({
      projectId: z.string().uuid().optional(),
      state: z.string().optional(),
      type: z.string().optional(),
      assigneeRole: z.string().optional(),
    }).parse(query);

    if (filters.projectId && !(await userCanAccessProject(userId, filters.projectId))) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const visible = filters.projectId ? [filters.projectId] : await visibleProjectIds(userId);
    if (!visible.length) return [];

    const conds = [inArray(tasks.projectId, visible)];
    if (filters.state) conds.push(eq(tasks.state, filters.state));
    if (filters.type) conds.push(eq(tasks.type, filters.type));
    if (filters.assigneeRole) conds.push(eq(tasks.assigneeRole, filters.assigneeRole));

    const rows = await getDb()
      .select()
      .from(tasks)
      .where(and(...conds))
      .orderBy(desc(tasks.createdAt));
    return parseRows(taskSchema, rows);
  });

  app.post("/tasks", async (request, reply) => {
    const userId = currentUserId(request);
    const agentRole = request.headers["x-agent-role"] as string | undefined;
    if (agentRole) {
      const check = canCreateTask(agentRole as AgentRole);
      if (!check.allowed) return reply.code(403).send({ error: check.reason });
    }

    const body = z.object({
      projectId: z.string().uuid(),
      parentId: z.string().uuid().optional(),
      title: z.string().min(1),
      description: z.string().optional(),
      type: z.enum(["epic", "task", "subtask", "bug", "feature"]).default("task"),
      state: z.string().default("new"),
      priority: z.enum(["low", "normal", "high", "immediate"]).default("normal"),
      assigneeRole: z.string().optional(),
      blockedBy: z.array(z.string().uuid()).default([]),
    }).parse(request.body);

    if (!(await userCanEditProject(userId, body.projectId))) {
      return reply.code(403).send({ error: "Insufficient permissions on project" });
    }

    const [row] = await getDb()
      .insert(tasks)
      .values({
        projectId: body.projectId,
        parentId: body.parentId ?? null,
        title: body.title,
        description: body.description ?? null,
        type: body.type,
        state: body.state,
        priority: body.priority,
        assigneeRole: body.assigneeRole ?? null,
        blockedBy: body.blockedBy,
      })
      .returning();
    return reply.code(201).send(parseRow(taskSchema, row));
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const userId = currentUserId(request);
    const pid = await projectIdOf("tasks", request.params.id);
    if (!pid || !(await userCanAccessProject(userId, pid))) {
      return reply.code(404).send({ error: "Task not found" });
    }
    const [row] = await getDb().select().from(tasks).where(eq(tasks.id, request.params.id)).limit(1);
    if (!row) return reply.code(404).send({ error: "Task not found" });
    return parseRow(taskSchema, row);
  });

  app.patch<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const userId = currentUserId(request);
    const pid = await projectIdOf("tasks", request.params.id);
    if (!pid || !(await userCanAccessProject(userId, pid))) {
      return reply.code(404).send({ error: "Task not found" });
    }
    if (!(await userCanEditProject(userId, pid))) {
      return reply.code(403).send({ error: "Insufficient permissions" });
    }
    const agentRole = request.headers["x-agent-role"] as string | undefined;
    if (agentRole) {
      const [t] = await getDb()
        .select({ assigneeRole: tasks.assigneeRole })
        .from(tasks)
        .where(eq(tasks.id, request.params.id))
        .limit(1);
      const check = canUpdateTask(
        agentRole as AgentRole,
        t?.assigneeRole ?? null,
        request.body as { state?: string },
      );
      if (!check.allowed) return reply.code(403).send({ error: check.reason });
    }

    const body = z.object({
      title: z.string().optional(),
      description: z.string().optional(),
      type: z.enum(["epic", "task", "subtask", "bug", "feature"]).optional(),
      state: z.string().optional(),
      priority: z.enum(["low", "normal", "high", "immediate"]).optional(),
      assigneeRole: z.string().nullable().optional(),
      blockedBy: z.array(z.string().uuid()).optional(),
      branchName: z.string().nullable().optional(),
      prUrl: z.string().nullable().optional(),
    }).parse(request.body);

    const updates: Record<string, unknown> = {};
    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description;
    if (body.type !== undefined) updates.type = body.type;
    if (body.state !== undefined) updates.state = body.state;
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.assigneeRole !== undefined) updates.assigneeRole = body.assigneeRole;
    if (body.blockedBy !== undefined) updates.blockedBy = body.blockedBy;
    if (body.branchName !== undefined) updates.branchName = body.branchName;
    if (body.prUrl !== undefined) updates.prUrl = body.prUrl;

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: "No fields to update" });
    }
    updates.updatedAt = sql`now()`;

    const [row] = await getDb()
      .update(tasks)
      .set(updates)
      .where(eq(tasks.id, request.params.id))
      .returning();
    if (!row) return reply.code(404).send({ error: "Task not found" });

    const parsed = parseRow(taskSchema, row);
    const doneStates = ["tested", "approved", "merged", "closed", "design_ready"];
    if (body.state && doneStates.includes(body.state)) {
      const unblocked = await checkUnblocked(parsed.id, parsed.projectId);
      if (unblocked.length > 0) {
        (parsed as Record<string, unknown>).unblockedTasks = unblocked;
      }
    }

    return parsed;
  });

  app.delete<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const userId = currentUserId(request);
    const pid = await projectIdOf("tasks", request.params.id);
    if (!pid || !(await userCanAccessProject(userId, pid))) {
      return reply.code(404).send({ error: "Task not found" });
    }
    if (!(await userCanEditProject(userId, pid))) {
      return reply.code(403).send({ error: "Insufficient permissions" });
    }
    const agentRole = request.headers["x-agent-role"] as string | undefined;
    if (agentRole) {
      const check = canDeleteTask(agentRole as AgentRole);
      if (!check.allowed) return reply.code(403).send({ error: check.reason });
    }

    const r = await getDb().delete(tasks).where(eq(tasks.id, request.params.id));
    if (!(r as { rowCount?: number }).rowCount) return reply.code(404).send({ error: "Task not found" });
    return { deleted: true };
  });

  // ─── Unfreeze ───
  //
  // Clear `frozen_reason` and zero out the safety counters so the task can be
  // picked up by the dispatcher again. Atomic so we can't reactivate while a
  // counter still holds the cap value.

  app.post<{ Params: { id: string } }>("/tasks/:id/unfreeze", async (request, reply) => {
    const userId = currentUserId(request);
    const pid = await projectIdOf("tasks", request.params.id);
    if (!pid || !(await userCanAccessProject(userId, pid))) {
      return reply.code(404).send({ error: "Task not found" });
    }
    if (!(await userCanEditProject(userId, pid))) {
      return reply.code(403).send({ error: "Insufficient permissions" });
    }
    const [row] = await getDb()
      .update(tasks)
      .set({
        frozenReason: null,
        revisionsCount: 0,
        failedCount: 0,
        signalsCount: 0,
        updatedAt: sql`now()`,
      })
      .where(eq(tasks.id, request.params.id))
      .returning();
    if (!row) return reply.code(404).send({ error: "Task not found" });
    return parseRow(taskSchema, row);
  });

  // ─── Task Comments ───

  app.get<{ Params: { id: string } }>("/tasks/:id/comments", async (request, reply) => {
    const userId = currentUserId(request);
    const pid = await projectIdOf("tasks", request.params.id);
    if (!pid || !(await userCanAccessProject(userId, pid))) {
      return reply.code(404).send({ error: "Task not found" });
    }
    const rows = await getDb()
      .select()
      .from(taskComments)
      .where(eq(taskComments.taskId, request.params.id))
      .orderBy(asc(taskComments.createdAt));
    return parseRows(commentSchema, rows);
  });

  app.post<{ Params: { id: string } }>("/tasks/:id/comments", async (request, reply) => {
    const userId = currentUserId(request);
    const pid = await projectIdOf("tasks", request.params.id);
    if (!pid || !(await userCanAccessProject(userId, pid))) {
      return reply.code(404).send({ error: "Task not found" });
    }
    if (!(await userCanEditProject(userId, pid))) {
      return reply.code(403).send({ error: "Insufficient permissions" });
    }
    const body = z.object({
      author: z.string().min(1),
      body: z.string().min(1),
    }).parse(request.body);

    const [row] = await getDb()
      .insert(taskComments)
      .values({ taskId: request.params.id, author: body.author, body: body.body })
      .returning();
    return reply.code(201).send(parseRow(commentSchema, row));
  });

  // ─── System Config ───

  const ALLOWED_KEYS = ["claude_auth", "claude_api_key", "github_token", "github_default_org", "github_default_branch", "orchestra_daily_cost_cap_usd"] as const;
  type ConfigKey = typeof ALLOWED_KEYS[number];
  type SystemConfigMap = Partial<Record<ConfigKey, string>>;

  app.get("/system-config", async () => {
    const { rows } = await getPool().query("SELECT key, value FROM system_config");
    const result: SystemConfigMap = {};
    for (const row of rows as { key: string; value: string }[]) {
      if (ALLOWED_KEYS.includes(row.key as ConfigKey)) {
        result[row.key as ConfigKey] = row.value;
      }
    }
    return result;
  });

  app.patch("/system-config", async (request, reply) => {
    const body = z.object({
      claude_auth: z.enum(["max", "api"]).optional(),
      claude_api_key: z.string().optional(),
      github_token: z.string().optional(),
      github_default_org: z.string().optional(),
      github_default_branch: z.string().optional(),
    }).parse(request.body);

    const pool = getPool();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      await pool.query(
        `INSERT INTO system_config (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value],
      );
    }

    const { rows } = await pool.query("SELECT key, value FROM system_config");
    const result: SystemConfigMap = {};
    for (const row of rows as { key: string; value: string }[]) {
      if (ALLOWED_KEYS.includes(row.key as ConfigKey)) {
        result[row.key as ConfigKey] = row.value;
      }
    }
    return reply.code(200).send(result);
  });
};
