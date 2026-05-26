import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { currentUserId } from "./auth";
import {
  assertPathInUserScope,
  getUserWorkspaceRoot,
  isPathInUserScope,
  ScopeViolationError,
} from "./workspace-scope";

/**
 * Server-side directory browser. Backs the dashboard's folder picker: the
 * orchestra-core process lives on the same machine as the code the agents
 * will operate on, so the absolute path it can see is the one we want for
 * `local_path` on a project. Browsers can't expose absolute paths from
 * their native folder pickers, so the dashboard renders its own modal and
 * walks the filesystem through this endpoint.
 *
 * No write access here — listing only (mkdir below is the one exception).
 * Per-user scope: every request is clamped to `<root>/<userId>/`. Other
 * users' subtrees are invisible — the picker can't even attempt to stat
 * them. The user's own scope dir is auto-created on first browse so a
 * fresh signup lands in an existing empty directory instead of a 404.
 */
export const fsPlugin: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { path?: string; showHidden?: string } }>(
    "/fs/browse",
    async (request, reply) => {
      const userId = currentUserId(request);
      const userScope = getUserWorkspaceRoot(userId);
      // Lazily create the user's scope dir so first-time browse doesn't 404.
      // chmod after mkdir: a pre-existing dir created before the 0o700 mode
      // landed (e.g. on volumes from earlier installs) stays at its old
      // permissions otherwise. UNIX dir mode is the second line of defense
      // against tenant A reading tenant B's tree even if a path-scope check
      // is bypassed app-side.
      await fs.mkdir(userScope, { recursive: true, mode: 0o700 });
      await fs.chmod(userScope, 0o700).catch(() => { /* best-effort */ });

      const showHidden = request.query.showHidden === "true";
      const raw = request.query.path;
      const requested = raw && raw.length > 0 ? path.resolve(raw) : userScope;

      if (!isPathInUserScope(userId, requested)) {
        return reply.code(403).send({
          error: `Путь вне вашей рабочей директории (${userScope}). Выберите папку внутри неё.`,
        });
      }

      let stat;
      try {
        stat = await fs.stat(requested);
      } catch {
        return reply.code(404).send({ error: `Path not found: ${requested}` });
      }
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: `Not a directory: ${requested}` });
      }

      let entries: Array<{ name: string; path: string; isDir: boolean; isGitRepo: boolean }> = [];
      try {
        const items = await fs.readdir(requested, { withFileTypes: true });
        // Filter to directories (we're picking a folder); skip hidden by
        // default — they're noise (.git, .DS_Store, .vscode, .cache, …).
        const dirs = items.filter((d) => d.isDirectory() && (showHidden || !d.name.startsWith(".")));
        entries = await Promise.all(dirs.map(async (d) => {
          const full = path.join(requested, d.name);
          // Cheap "is this a repo?" check so the UI can put a git mark on
          // entries that the user probably wants. stat(.git) is cheap.
          let isGitRepo = false;
          try {
            const gitStat = await fs.stat(path.join(full, ".git"));
            isGitRepo = gitStat.isDirectory() || gitStat.isFile();
          } catch {
            // not a repo or unreadable — fine
          }
          return { name: d.name, path: full, isDir: true, isGitRepo };
        }));
        entries.sort((a, b) => a.name.localeCompare(b.name));
      } catch (err) {
        return reply.code(403).send({ error: `Cannot read ${requested}: ${(err as Error).message}` });
      }

      // Parent is null when sitting on the user's scope root — there's
      // nothing meaningful above it for the picker to navigate into.
      const parent = requested === userScope ? null : path.dirname(requested);

      return { cwd: requested, parent, home: userScope, entries, workspaceRoot: userScope };
    },
  );

  /**
   * Create a new subdirectory inside `parent`. Used by the folder picker's
   * "New folder" affordance so the user can scaffold a project directory
   * without dropping to a terminal. Single-segment names only — no path
   * traversal, no nested creation — to keep this a small, predictable op.
   */
  app.post<{ Body: { parent: string; name: string } }>(
    "/fs/mkdir",
    async (request, reply) => {
      const userId = currentUserId(request);
      const body = MkdirBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "parent и name обязательны" });
      }
      const name = body.data.name.trim();
      if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
        return reply.code(400).send({ error: "Недопустимое имя папки" });
      }
      const parentPath = path.resolve(body.data.parent);
      try {
        assertPathInUserScope(userId, parentPath);
      } catch (err) {
        if (err instanceof ScopeViolationError) return reply.code(403).send({ error: err.message });
        throw err;
      }
      let parentStat;
      try {
        parentStat = await fs.stat(parentPath);
      } catch {
        return reply.code(404).send({ error: `Родительская папка не найдена: ${parentPath}` });
      }
      if (!parentStat.isDirectory()) {
        return reply.code(400).send({ error: `Не папка: ${parentPath}` });
      }
      const target = path.join(parentPath, name);
      try {
        await fs.mkdir(target);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EEXIST") {
          return reply.code(409).send({ error: "Папка уже существует" });
        }
        if (e.code === "EACCES" || e.code === "EPERM") {
          return reply.code(403).send({ error: `Нет прав на создание в ${parentPath}` });
        }
        return reply.code(500).send({ error: `Не удалось создать папку: ${e.message}` });
      }
      return { path: target };
    },
  );
};

const MkdirBodySchema = z.object({
  parent: z.string().min(1),
  name: z.string().min(1).max(255),
});

// Exposed for tests.
export const _querySchema = z.object({
  path: z.string().optional(),
  showHidden: z.enum(["true", "false"]).optional(),
});
