import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Server-side directory browser. Backs the dashboard's folder picker: the
 * orchestra-core process lives on the same machine as the code the agents
 * will operate on, so the absolute path it can see is the one we want for
 * `local_path` on a project. Browsers can't expose absolute paths from
 * their native folder pickers, so the dashboard renders its own modal and
 * walks the filesystem through this endpoint.
 *
 * No write access — listing only. The `requireAuth` preHandler in index.ts
 * gates this behind a logged-in user; single-tenant deployments treat
 * filesystem read as fine.
 */
export const fsPlugin: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { path?: string; showHidden?: string } }>(
    "/fs/browse",
    async (request, reply) => {
      const showHidden = request.query.showHidden === "true";
      const raw = request.query.path;
      const requested = raw && raw.length > 0 ? path.resolve(raw) : os.homedir();

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

      // Parent is null at the filesystem root so the UI can hide the "up"
      // button there. `path.dirname("/")` returns "/" so we guard explicitly.
      const parent = requested === path.parse(requested).root ? null : path.dirname(requested);
      const home = os.homedir();

      return { cwd: requested, parent, home, entries };
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
      const body = MkdirBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "parent и name обязательны" });
      }
      const name = body.data.name.trim();
      if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
        return reply.code(400).send({ error: "Недопустимое имя папки" });
      }
      const parentPath = path.resolve(body.data.parent);
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
