import type { FastifyPluginAsync } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { simpleGit } from "simple-git";
import { eq, sql } from "drizzle-orm";
import type { ProjectSettings } from "@ai-orchestra/shared";
import { getDb } from "./db";
import { projects } from "./db/schema";
import { currentUserId } from "./auth";
import { userCanEditProject } from "./project-access";
import { assertPathInUserScope, ScopeViolationError } from "./workspace-scope";
import { normalizeProviderSecretsForWrite, getProjectGitToken } from "./project-secrets";
import { providerFor } from "./providers";
import { log } from "./obs";

/**
 * Clone-into-localPath endpoint. The user picked a destination path via the
 * FolderPicker (must be inside their per-user scope and must not exist yet)
 * and supplied the git URL + token. orchestra-core spawns `git clone` in the
 * background and the dashboard polls /status for progress.
 *
 * Why a dedicated endpoint vs. cloning lazily on first agent spawn (the
 * old flow): users want a visible "is the clone working?" loop before they
 * schedule any work. A 401-on-spawn buried in a session log is hostile UX
 * — the explicit POST surfaces auth/URL errors in the create modal where
 * the user can fix them inline.
 *
 * Token is encrypted and persisted into `settings.provider.token` so future
 * pushes/fetches/PR ops don't need the user to re-paste it. Path validation
 * runs once on POST — by the time the worker starts the path is guaranteed
 * legal.
 */

type CloneState =
  | { state: "idle" }
  | { state: "running"; startedAt: number }
  | { state: "success"; finishedAt: number }
  | { state: "error"; error: string; finishedAt: number };

const cloneStatus = new Map<string, CloneState>();

export const clonePlugin: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>("/projects/:id/clone", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.params.id;
    if (!(await userCanEditProject(userId, projectId))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }

    const body = z.object({
      // Optional: if omitted, take repoUrl from the project. The first-time
      // clone usually comes from the modal which posts both fields together.
      repoUrl: z.string().url().optional(),
      // Plaintext on the wire, encrypted before write — see project-secrets.
      // Optional for public repos.
      token: z.string().min(1).optional(),
    }).parse(request.body);

    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return reply.code(404).send({ error: "Проект не найден" });

    const repoUrl = body.repoUrl ?? project.repoUrl;
    if (!repoUrl) {
      return reply.code(400).send({
        error: "У проекта не указан repoUrl и в запросе он тоже отсутствует — клонировать нечего",
      });
    }

    const targetPath = project.localPath;
    if (!targetPath) {
      return reply.code(400).send({
        error: "У проекта не указан localPath — выберите путь куда клонировать",
      });
    }
    const resolvedTarget = path.resolve(targetPath);

    try {
      assertPathInUserScope(userId, resolvedTarget);
    } catch (err) {
      if (err instanceof ScopeViolationError) return reply.code(403).send({ error: err.message });
      throw err;
    }

    // git clone refuses to write into a non-empty directory, but allows an
    // existing empty one. The dashboard also creates the folder on its own
    // when the user picks a localPath via FolderPicker — refusing to clone
    // there would force them to delete and re-create the project.
    if (fs.existsSync(resolvedTarget)) {
      const dotGit = path.join(resolvedTarget, ".git");
      if (fs.existsSync(dotGit)) {
        return reply.code(409).send({
          error: `Репозиторий по пути \`${resolvedTarget}\` уже инициализирован — используйте «Pull» для обновления.`,
        });
      }
      const entries = fs.readdirSync(resolvedTarget);
      if (entries.length > 0) {
        return reply.code(409).send({
          error: `Путь \`${resolvedTarget}\` не пустой и не git-репозиторий — клонировать туда небезопасно. Очистите папку или укажите другой путь.`,
        });
      }
      // Empty existing folder: git can clone into it. simple-git's clone()
      // passes through to `git clone <url> <dir>` which accepts this case.
    }

    const inFlight = cloneStatus.get(projectId);
    if (inFlight?.state === "running") {
      return reply.code(409).send({ error: "Клон уже выполняется для этого проекта" });
    }

    // Persist URL + encrypted token BEFORE spawning the clone, so the worker
    // pulls them from the DB if it restarts and so later push/PR ops have
    // them. normalizeProviderSecretsForWrite encrypts the token in flight.
    const settingsPatch: Record<string, unknown> = {};
    if (body.token) settingsPatch.provider = { token: body.token };
    const normalizedPatch = normalizeProviderSecretsForWrite(settingsPatch);
    await db
      .update(projects)
      .set({
        repoUrl,
        ...(Object.keys(normalizedPatch).length > 0
          ? { settings: sql`${projects.settings} || ${JSON.stringify(normalizedPatch)}::jsonb` }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(projects.id, projectId));

    cloneStatus.set(projectId, { state: "running", startedAt: Date.now() });

    // Fire and forget — caller polls /status. Status map is the single
    // source of truth for "did this finish?".
    void runClone(projectId, repoUrl, resolvedTarget).catch((err) => {
      log.error({ err, projectId }, "clone worker crashed");
      cloneStatus.set(projectId, {
        state: "error",
        error: err instanceof Error ? err.message : String(err),
        finishedAt: Date.now(),
      });
    });

    return reply.code(202).send({ state: "running" });
  });

  app.get<{ Params: { id: string } }>("/projects/:id/clone/status", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.params.id;
    if (!(await userCanEditProject(userId, projectId))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }
    const status = cloneStatus.get(projectId) ?? { state: "idle" };
    return status;
  });
};

/**
 * Background worker. Reads the stored encrypted token, bakes it into the
 * clone URL, calls `git clone`, and writes the outcome into the status
 * map. Errors are surfaced verbatim — git's own messages tend to be the
 * actionable signal a user needs ("Repository not found", "Authentication
 * failed", "Permission denied").
 */
async function runClone(projectId: string, repoUrl: string, targetPath: string): Promise<void> {
  try {
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) throw new Error(`project ${projectId} disappeared mid-clone`);

    let authedUrl = repoUrl;
    const token = getProjectGitToken(project.settings);
    if (token) {
      try {
        const provider = providerFor(repoUrl, project.settings as ProjectSettings | null);
        authedUrl = provider.tokenizeCloneUrl();
      } catch (err) {
        // Provider couldn't resolve (e.g. unknown host) — try the plain URL.
        // Public repos work without auth; a private repo will surface a clean
        // "authentication failed" error from git which is what we want.
        log.warn({ err, projectId }, "clone: token tokenize failed, retrying with plain URL");
      }
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    await simpleGit().clone(authedUrl, targetPath);

    cloneStatus.set(projectId, { state: "success", finishedAt: Date.now() });
    log.info({ projectId, targetPath }, "clone completed");
  } catch (err) {
    // Re-thrown so the outer catch in the route handler logs + updates status.
    throw err;
  }
}
