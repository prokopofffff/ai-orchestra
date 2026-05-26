import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ProjectSchema, TaskSchema, TaskCommentSchema, TaskStateSchema } from "@ai-orchestra/shared";
import { getDb, getPool } from "./db";
import { projects, tasks, taskComments, conversations, projectNotes } from "./db/schema";
import { parseRow, parseRows } from "./db-utils";
import { checkUnblocked, DONE_STATES } from "./dependency-engine";
import { resolveRuntimeForRole } from "./agents/runtime/resolver";
import { notify } from "./notification-hub";
import { canCreateTask, canUpdateTask, canDeleteTask } from "./agent-auth";
import { currentUserId } from "./auth";
import {
  userCanAccessProject, userCanEditProject, userCanReferenceProject,
  visibilityFilter, visibleProjectIds, projectIdOf,
} from "./project-access";
import { createIntroTask } from "./intro-task";
import { reconcileTelegramNow } from "./telegram-manager";
import { isGitRepo, initGitRepo, git, rewriteOriginAuth } from "./repo-manager";
import { normalizeProviderSecretsForWrite } from "./project-secrets";
import { loadConfig } from "./config";
import type { AgentRole } from "./config";
import { providerForProject, providerFor } from "./providers";
import type { ProjectSettings } from "@ai-orchestra/shared";
import { log } from "./obs";

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

    // Slug derivation: keep ASCII alphanumerics + dashes (URL-friendly).
    // For names that strip to nothing (cyrillic, kanji, emoji-only…) fall
    // back to a short random suffix so we never produce `-` or `""`.
    const slug = body.slug ?? (() => {
      const stripped = body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (stripped.length > 0) return stripped;
      // crypto.randomUUID is available everywhere we run.
      return `project-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36)).slice(0, 8)}`;
    })();
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
    // there's actually a repo to look at AND tech-lead's resolved runtime
    // is ready (Claude OR Codex configured, depending on what the project
    // assigned to the tech-lead role). Without the check, the intro task
    // would spawn TL and the CLI would 401 — a confusing first impression
    // for a brand-new signup whose checklist hasn't yet guided them through
    // credentials. We post a system message pointing at Settings instead.
    if (row.repoUrl || row.localPath) {
      const resolved = await resolveRuntimeForRole({
        projectId: row.id, role: "tech-lead",
        settings: row.settings, config: loadConfig(),
      });
      if (!resolved.ok) {
        notify({
          projectId: row.id,
          text:
            `Проект создан. Задача знакомства с кодом отложена до настройки ИИ-провайдера для этого проекта. ${resolved.reason} ` +
            "После настройки откройте Настройки → Знакомство → Запустить заново.",
          priority: "normal",
          fromRole: "system",
        }).catch(() => { /* best-effort */ });
      } else {
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
    }

    return reply.code(201).send(parseRow(projectSchema, row));
  });

  app.get<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    const userId = currentUserId(request);
    if (!(await userCanAccessProject(userId, request.params.id))) {
      return reply.code(404).send({ error: "Проект не найден" });
    }
    const db = getDb();
    const [row] = await db.select().from(projects).where(eq(projects.id, request.params.id)).limit(1);
    if (!row) return reply.code(404).send({ error: "Проект не найден" });
    return parseRow(projectSchema, row);
  });

  app.patch<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    const userId = currentUserId(request);
    if (!(await userCanEditProject(userId, request.params.id))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
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

    // Reference projects: every UUID in settings.referenceProjects must be a
    // project the current user can actually read. Without this check, a
    // user could leak file contents from a project they can't see by linking
    // it as a reference, since the bootstrap injector reads files at
    // dispatch time. Self-references are disallowed (pointless + would
    // recurse on future card features).
    if (body.settings && Array.isArray((body.settings as { referenceProjects?: unknown }).referenceProjects)) {
      const refs = ((body.settings as { referenceProjects: unknown[] }).referenceProjects)
        .filter((x): x is string => typeof x === "string");
      const deduped = Array.from(new Set(refs));
      if (deduped.includes(request.params.id)) {
        return reply.code(400).send({ error: "Проект не может ссылаться сам на себя" });
      }
      for (const refId of deduped) {
        if (!(await userCanReferenceProject(userId, refId))) {
          return reply.code(403).send({
            error: `Нет доступа к проекту ${refId} — нельзя добавить его как референс`,
          });
        }
      }
      // Normalize stored value (dedupe applied above).
      (body.settings as { referenceProjects: string[] }).referenceProjects = deduped;
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.repoUrl !== undefined) updates.repoUrl = body.repoUrl;
    if (body.localPath !== undefined) updates.localPath = body.localPath;
    if (body.description !== undefined) updates.description = body.description;
    // settings merges via jsonb concat — drizzle's set() doesn't have a direct
    // operator for `||`, so reach for `sql` here. Still typed at the column.
    // Plaintext provider.token is encrypted in-flight so the DB never sees it.
    if (body.settings !== undefined) {
      const normalized = normalizeProviderSecretsForWrite(body.settings);
      updates.settings = sql`${projects.settings} || ${JSON.stringify(normalized)}::jsonb`;
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
    if (!row) return reply.code(404).send({ error: "Проект не найден" });
    // If the patch touched telegram settings, kick the manager so it
    // starts / stops / restarts loops without waiting for the 30s timer.
    if (body.settings && (body.settings as { telegram?: unknown }).telegram !== undefined) {
      reconcileTelegramNow().catch(() => { /* best-effort */ });
    }
    // Re-tokenize the local checkout's origin if the user just rotated their
    // token or pointed the project at a different remote. Without this, a
    // pre-existing clone keeps its bare HTTPS origin and `git push` from the
    // agent fails with "could not read Username for 'https://…'" — fresh
    // clones avoid this because clone-api bakes the token into the URL, but
    // for projects that pre-date the token being entered (or where the user
    // updated it in Settings later) we have to do it explicitly here.
    const touchedToken =
      body.settings !== undefined &&
      (body.settings as { provider?: { token?: unknown } }).provider?.token !== undefined;
    if ((touchedToken || body.repoUrl !== undefined) && row.localPath && row.repoUrl) {
      try {
        const provider = providerFor(row.repoUrl, row.settings as ProjectSettings | null);
        const authUrl = provider.tokenizeCloneUrl();
        await rewriteOriginAuth(row.localPath, authUrl);
      } catch (err) {
        // Provider resolution failure (no token, unknown host) shouldn't
        // poison the settings save — log and continue. The user still gets
        // the dashboard's "save successful" response and can retry once
        // their token is configured.
        log.warn({ err, projectId: row.id }, "PATCH /projects/:id: origin rewrite skipped");
      }
    }
    return parseRow(projectSchema, row);
  });

  // ─── Ad-hoc refresh of the local checkout's origin URL ───
  //
  // Same logic as the PATCH side-effect, exposed as a stand-alone trigger
  // so the dashboard can offer a "Refresh git credentials" button without
  // requiring the user to make a no-op settings save. Useful when the
  // credential setup is fine but the local origin was set up before the
  // token existed.
  app.post<{ Params: { id: string } }>("/projects/:id/refresh-git-creds", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.params.id;
    if (!(await userCanEditProject(userId, projectId))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }
    const [row] = await getDb()
      .select({ localPath: projects.localPath, repoUrl: projects.repoUrl, settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "Проект не найден" });
    if (!row.localPath) return reply.code(400).send({ error: "У проекта не задан локальный путь" });
    if (!row.repoUrl) return reply.code(400).send({ error: "У проекта не задан remote URL" });
    try {
      const provider = providerFor(row.repoUrl, row.settings as ProjectSettings | null);
      const authUrl = provider.tokenizeCloneUrl();
      const rewritten = await rewriteOriginAuth(row.localPath, authUrl);
      if (!rewritten) {
        return reply.code(409).send({
          error: `Путь \`${row.localPath}\` не является git-репозиторием — сначала склонируйте.`,
        });
      }
      return { refreshed: true };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
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
      return reply.code(404).send({ error: "Проект не найден" });
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
      return reply.code(403).send({ error: "Недостаточно прав" });
    }
    // Preflight: same gate as POST /projects. If tech-lead's resolved
    // runtime isn't ready (no Claude OR Codex creds for the configured
    // provider) we'd burn the task spawning a TL that immediately 401s.
    const [proj] = await getDb()
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!proj) return reply.code(404).send({ error: "Проект не найден" });
    const resolved = await resolveRuntimeForRole({
      projectId, role: "tech-lead",
      settings: proj.settings, config: loadConfig(),
    });
    if (!resolved.ok) return reply.code(409).send({ error: resolved.reason });

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
      return reply.code(404).send({ error: "Проект не найден" });
    }
    const [row] = await getDb()
      .select({ localPath: projects.localPath, repoUrl: projects.repoUrl })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "Проект не найден" });

    const localPath = row.localPath ?? null;
    const hasRemoteUrl = !!row.repoUrl;
    let exists = false;
    let isGit = false;
    let isEmpty = false;
    if (localPath) {
      const fs = await import("node:fs");
      exists = fs.existsSync(localPath);
      if (exists) {
        isGit = isGitRepo(localPath);
        if (!isGit) {
          try {
            isEmpty = fs.readdirSync(localPath).length === 0;
          } catch {
            isEmpty = false;
          }
        }
      }
    }
    return {
      localPath,
      hasRemoteUrl,
      exists,
      isGitRepo: isGit,
      // Suggest "Clone repo" when there is a remote URL and the destination
      // is either missing or an empty folder — git can clone into both.
      canClone: !!localPath && hasRemoteUrl && (!exists || isEmpty),
      // Suggest "Pull" only when the local path is already a working repo.
      canPull: !!localPath && isGit && hasRemoteUrl,
      // "Init git here" — folder exists, has content, but isn't a repo.
      // When a remote URL is also configured and the folder is empty we
      // prefer the Clone action above; everything else falls through to
      // letting the user start fresh with `git init` in place.
      needsInit: !!localPath && exists && !isGit && !isEmpty,
    };
  });

  // POST /projects/:id/pull — fetch origin, checkout default branch, ff-pull.
  // Surfaced as a "Pull from main" button in Settings so the user can refresh
  // the local checkout without spawning an agent. Errors (non-fast-forward,
  // detached HEAD with local commits, etc.) are returned verbatim — they
  // require human intervention and we don't want to silently rewrite refs.
  app.post<{ Params: { id: string } }>("/projects/:id/pull", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.params.id;
    if (!(await userCanEditProject(userId, projectId))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }
    const [row] = await getDb()
      .select({ localPath: projects.localPath })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row?.localPath) {
      return reply.code(400).send({ error: "У проекта не задан локальный путь." });
    }
    if (!isGitRepo(row.localPath)) {
      return reply.code(400).send({ error: "По указанному пути нет git-репозитория — сначала склонируйте его." });
    }
    const defaultBranch = loadConfig().githubDefaultBranch;
    try {
      const g = git(row.localPath);
      await g.fetch("origin");
      await g.checkout(defaultBranch);
      // --ff-only: refuse to merge if the local branch has diverged. Safer
      // than a merge that might leave the workspace in a half-resolved state.
      await g.pull("origin", defaultBranch, { "--ff-only": null });
      const headSha = (await g.revparse(["HEAD"])).trim();
      return { pulled: true, branch: defaultBranch, head: headSha };
    } catch (err) {
      return reply.code(409).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post<{ Params: { id: string } }>("/projects/:id/init-git", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.params.id;
    if (!(await userCanEditProject(userId, projectId))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }

    const [row] = await getDb()
      .select({ localPath: projects.localPath })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row?.localPath) {
      return reply.code(400).send({ error: "У проекта не задан локальный путь для инициализации." });
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
    if (!row) return reply.code(404).send({ error: "Проект не найден" });
    if (row.ownerId !== userId) {
      return reply.code(403).send({ error: "Только владелец проекта может его удалить" });
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
      return reply.code(404).send({ error: "Проект не найден" });
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
      return reply.code(403).send({ error: "Недостаточно прав доступа к проекту" });
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
      return reply.code(404).send({ error: "Задача не найдена" });
    }
    const [row] = await getDb().select().from(tasks).where(eq(tasks.id, request.params.id)).limit(1);
    if (!row) return reply.code(404).send({ error: "Задача не найдена" });
    return parseRow(taskSchema, row);
  });

  app.patch<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const userId = currentUserId(request);
    const pid = await projectIdOf("tasks", request.params.id);
    if (!pid || !(await userCanAccessProject(userId, pid))) {
      return reply.code(404).send({ error: "Задача не найдена" });
    }
    if (!(await userCanEditProject(userId, pid))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
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
      // Strict enum: a loose z.string() let agents send `state: "done"` or
      // `"completed"`, which wrote a non-canonical value to the DB and then
      // 500'd on the response parse (TaskSchema is strict). The reconciler
      // then kept respawning the agent off the stuck `designing` state,
      // spamming Telegram. See dependency-engine DONE_STATES for the real
      // terminal values: closed / merged / design_ready.
      state: TaskStateSchema.optional(),
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
    if (!row) return reply.code(404).send({ error: "Задача не найдена" });

    const parsed = parseRow(taskSchema, row);
    if (body.state && (DONE_STATES as readonly string[]).includes(body.state)) {
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
      return reply.code(404).send({ error: "Задача не найдена" });
    }
    if (!(await userCanEditProject(userId, pid))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }
    const agentRole = request.headers["x-agent-role"] as string | undefined;
    if (agentRole) {
      const check = canDeleteTask(agentRole as AgentRole);
      if (!check.allowed) return reply.code(403).send({ error: check.reason });
    }

    const r = await getDb().delete(tasks).where(eq(tasks.id, request.params.id));
    if (!(r as { rowCount?: number }).rowCount) return reply.code(404).send({ error: "Задача не найдена" });
    return { deleted: true };
  });

  // ─── Manual merge ───
  //
  // User-initiated merge of the task's PR. Same provider call as the
  // background auto-merge path; difference is the trigger (button click
  // vs `pr_approved` signal) and the response shape (synchronous status
  // back to the UI instead of a notification). Returns 409 for soft
  // refusals (conflicts, branch protection, failed checks) so the
  // dashboard can show a precise reason without distinguishing from
  // transport errors.

  app.post<{ Params: { id: string } }>("/tasks/:id/merge", async (request, reply) => {
    const userId = currentUserId(request);
    const pid = await projectIdOf("tasks", request.params.id);
    if (!pid || !(await userCanAccessProject(userId, pid))) {
      return reply.code(404).send({ error: "Задача не найдена" });
    }
    if (!(await userCanEditProject(userId, pid))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }
    const { rows } = await getPool().query<{ pr_url: string | null; state: string; title: string }>(
      "SELECT pr_url, state, title FROM tasks WHERE id = $1 LIMIT 1",
      [request.params.id],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "Задача не найдена" });
    if (!row.pr_url) return reply.code(400).send({ error: "У задачи нет PR для мержа" });
    if (row.state === "merged" || row.state === "closed") {
      return reply.code(409).send({ error: `Task is already ${row.state}` });
    }

    let provider;
    try {
      provider = await providerForProject(pid);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }

    try {
      const result = await provider.mergePR(row.pr_url, { method: "squash" });
      if (result.merged) {
        // Don't flip task.state here — leave it to the webhook + pr-watcher
        // path so manual and auto-merge converge on the same downstream
        // effects (QA dispatch, dependency unblock).
        return reply.send({ merged: true, sha: result.sha });
      }
      return reply.code(409).send({ error: result.reason });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, taskId: request.params.id, prUrl: row.pr_url }, "manual merge failed");
      return reply.code(502).send({ error: msg });
    }
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
      return reply.code(404).send({ error: "Задача не найдена" });
    }
    if (!(await userCanEditProject(userId, pid))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
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
    if (!row) return reply.code(404).send({ error: "Задача не найдена" });
    return parseRow(taskSchema, row);
  });

  // ─── Task Comments ───

  app.get<{ Params: { id: string } }>("/tasks/:id/comments", async (request, reply) => {
    const userId = currentUserId(request);
    const pid = await projectIdOf("tasks", request.params.id);
    if (!pid || !(await userCanAccessProject(userId, pid))) {
      return reply.code(404).send({ error: "Задача не найдена" });
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
      return reply.code(404).send({ error: "Задача не найдена" });
    }
    if (!(await userCanEditProject(userId, pid))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
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

  // Orchestra-wide settings that are SAFE to share across users:
  //   - claude_auth:  mode default (max vs api), not a credential
  //   - github_default_org / github_default_branch: defaults for new projects
  //   - orchestra_daily_cost_cap_usd: shared spending guardrail
  //
  // What's NOT here anymore (security):
  //   - claude_api_key, github_token, gitlab_token
  //     These were shared across all users — a token pasted by one user
  //     would silently authorize agent runs for every other user. They're
  //     per-project now via settings.claude.apiKey and
  //     settings.provider.token. The Settings UI surfaces both.
  const ALLOWED_KEYS = ["claude_auth", "github_default_org", "github_default_branch", "orchestra_daily_cost_cap_usd"] as const;
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
