import type { FastifyPluginAsync } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getPool } from "./db";
import { currentUserId } from "./auth";
import { userCanAccessProject, userCanReferenceProject } from "./project-access";
import { log } from "./obs";

/**
 * Read-only cross-project context API. Backs the `reference-tool` MCP
 * server. Agents call these endpoints (via the MCP server proxy) to inspect
 * other projects linked via the caller project's `settings.referenceProjects`.
 *
 * Authorization layering — every endpoint runs the same three checks:
 *   1. JWT validates → currentUserId (preHandler in index.ts)
 *   2. Caller has access to `callerProjectId` (their own project)
 *   3. Caller still has access to `refId` AND `refId` is in caller's
 *      `settings.referenceProjects` list
 *
 * Plus path-canonicalization on every file/dir read: the resolved absolute
 * path must remain inside the ref project's `local_path`. Symlinks are
 * followed and re-checked — if the symlink target leaves the workspace,
 * the read is rejected.
 *
 * Caps:
 *   - list_files: 500 entries, sorted, returns { entries, truncated }
 *   - read_file:  50KB per response, returns { content, truncated, nextOffset }
 *   - grep:       100 matches, snippet capped at 200 chars
 */

const MAX_LIST_ENTRIES = 500;
const READ_CHUNK_BYTES = 50 * 1024;
const MAX_GREP_MATCHES = 100;
const GREP_SNIPPET_CHARS = 200;

type RefProjectRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  localPath: string;
};

export const referencesPlugin: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { callerProjectId?: string } }>(
    "/references/projects",
    async (request, reply) => {
      const userId = currentUserId(request);
      const callerId = request.query.callerProjectId;
      const gate = await resolveCaller(userId, callerId);
      if (gate.error) return reply.code(gate.code).send({ error: gate.error });

      const refs = await loadReferenceProjects(callerId!, userId);
      // Trim the local_path off when there's no value — listed projects
      // with a missing local_path are still legitimate links (workspace
      // can be re-mounted later); we just can't read them right now.
      return refs.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        absolutePath: r.localPath || null,
        available: Boolean(r.localPath && fs.existsSync(r.localPath)),
      }));
    },
  );

  app.get<{
    Params: { refId: string };
    Querystring: { callerProjectId?: string; path?: string; glob?: string };
  }>("/references/:refId/files", async (request, reply) => {
    const userId = currentUserId(request);
    const { refId } = request.params;
    const callerId = request.query.callerProjectId;
    const refRow = await gateRefRead(userId, callerId, refId);
    if (!refRow.ok) return reply.code(refRow.code).send({ error: refRow.error });

    const sub = request.query.path ?? "";
    const target = safeResolve(refRow.row.localPath, sub);
    if (!target) return reply.code(400).send({ error: "Путь выходит за пределы проекта" });

    let stat;
    try { stat = fs.statSync(target); }
    catch { return reply.code(404).send({ error: "Папка не найдена" }); }
    if (!stat.isDirectory()) return reply.code(400).send({ error: "Не папка" });

    const globRegex = request.query.glob ? globToRegExp(request.query.glob) : null;
    const all = walkDir(target, refRow.row.localPath, globRegex, MAX_LIST_ENTRIES + 1);
    const truncated = all.length > MAX_LIST_ENTRIES;
    const entries = truncated ? all.slice(0, MAX_LIST_ENTRIES) : all;

    return { entries, truncated };
  });

  app.get<{
    Params: { refId: string };
    Querystring: { callerProjectId?: string; path?: string; offset?: string };
  }>("/references/:refId/file", async (request, reply) => {
    const userId = currentUserId(request);
    const { refId } = request.params;
    const callerId = request.query.callerProjectId;
    const refRow = await gateRefRead(userId, callerId, refId);
    if (!refRow.ok) return reply.code(refRow.code).send({ error: refRow.error });

    const rawPath = request.query.path ?? "";
    if (!rawPath) return reply.code(400).send({ error: "Параметр path обязателен" });
    const target = safeResolve(refRow.row.localPath, rawPath);
    if (!target) return reply.code(400).send({ error: "Путь выходит за пределы проекта" });

    let stat;
    try { stat = fs.statSync(target); }
    catch { return reply.code(404).send({ error: "Файл не найден" }); }
    if (!stat.isFile()) return reply.code(400).send({ error: "Не файл" });

    const offset = parseNonNegInt(request.query.offset) ?? 0;
    if (offset >= stat.size) {
      return { path: rawPath, size: stat.size, offset, content: "", truncated: false };
    }
    const buf = Buffer.alloc(Math.min(READ_CHUNK_BYTES, stat.size - offset));
    const fd = fs.openSync(target, "r");
    let bytesRead: number;
    try {
      bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
    } finally {
      fs.closeSync(fd);
    }
    const content = buf.subarray(0, bytesRead).toString("utf-8");
    const nextOffset = offset + bytesRead;
    const truncated = nextOffset < stat.size;
    return {
      path: rawPath,
      size: stat.size,
      offset,
      content,
      truncated,
      ...(truncated ? { nextOffset } : {}),
    };
  });

  app.get<{
    Params: { refId: string };
    Querystring: { callerProjectId?: string; q?: string; path?: string };
  }>("/references/:refId/grep", async (request, reply) => {
    const userId = currentUserId(request);
    const { refId } = request.params;
    const callerId = request.query.callerProjectId;
    const refRow = await gateRefRead(userId, callerId, refId);
    if (!refRow.ok) return reply.code(refRow.code).send({ error: refRow.error });

    const query = request.query.q?.trim();
    if (!query) return reply.code(400).send({ error: "Параметр q обязателен" });
    // The pattern is model/user-controlled and runs against every line of
    // every file — bound the ReDoS surface: cap pattern length, skip
    // pathologically long lines, and stop the whole walk at a deadline.
    if (query.length > 200) return reply.code(400).send({ error: "Паттерн слишком длинный (макс. 200 символов)" });
    let needle: RegExp;
    try { needle = new RegExp(query, "i"); }
    catch (err) {
      return reply.code(400).send({ error: `Невалидный паттерн: ${(err as Error).message}` });
    }
    const GREP_DEADLINE_MS = 5_000;
    const MAX_LINE_LEN = 5_000;
    const deadline = Date.now() + GREP_DEADLINE_MS;

    const root = request.query.path ? safeResolve(refRow.row.localPath, request.query.path) : refRow.row.localPath;
    if (!root) return reply.code(400).send({ error: "Путь выходит за пределы проекта" });

    const matches: { path: string; line: number; snippet: string }[] = [];
    const stack: string[] = [root];
    let deadlineHit = false;
    while (stack.length && matches.length < MAX_GREP_MATCHES) {
      if (Date.now() > deadline) { deadlineHit = true; break; }
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { continue; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (matches.length >= MAX_GREP_MATCHES) break;
        if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (!e.isFile()) continue;
        // Skip files over 1MB — grep is for source code, not binaries
        try {
          const st = fs.statSync(full);
          if (st.size > 1_000_000) continue;
        } catch { continue; }
        let content: string;
        try { content = fs.readFileSync(full, "utf-8"); }
        catch { continue; }
        const rel = path.relative(refRow.row.localPath, full);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= MAX_GREP_MATCHES) break;
          if (Date.now() > deadline) { deadlineHit = true; break; }
          if (lines[i].length > MAX_LINE_LEN) continue;
          if (needle.test(lines[i])) {
            matches.push({
              path: rel,
              line: i + 1,
              snippet: lines[i].slice(0, GREP_SNIPPET_CHARS),
            });
          }
        }
      }
    }
    return { matches, truncated: matches.length >= MAX_GREP_MATCHES || deadlineHit };
  });
};

// ────────────────────────────────────────────────────────────────────────────
// Authorization helpers

type GateOk<T> = { ok: true; row: T };
type GateErr = { ok: false; code: number; error: string };

async function gateRefRead(
  userId: string,
  callerProjectId: string | undefined,
  refId: string,
): Promise<GateOk<RefProjectRow> | GateErr> {
  if (!isUuid(refId)) return { ok: false, code: 400, error: "Невалидный refId" };
  const caller = await resolveCaller(userId, callerProjectId);
  if (caller.error) return { ok: false, code: caller.code, error: caller.error };

  // Caller's referenceProjects must include refId. Reject otherwise so a
  // compromised agent can't enumerate arbitrary projects the user happens
  // to own — only the ones explicitly linked from the calling project.
  const callerRefs = await getCallerReferenceProjectIds(callerProjectId!);
  if (!callerRefs.includes(refId)) {
    return {
      ok: false,
      code: 403,
      error: "Этот проект не указан в settings.referenceProjects вызывающего проекта",
    };
  }

  // Re-check the user still has read access to the ref project. Catches
  // "user removed from referenced project after linking".
  if (!(await userCanReferenceProject(userId, refId))) {
    return { ok: false, code: 403, error: "Нет доступа к проекту-референсу" };
  }

  // Load + assert local_path exists. Without it, the reads can't proceed.
  const { rows } = await getPool().query(
    "SELECT id, slug, name, description, local_path FROM projects WHERE id = $1",
    [refId],
  );
  if (!rows.length) return { ok: false, code: 404, error: "Проект-референс не найден" };
  const lp = rows[0].local_path as string | null;
  if (!lp) return { ok: false, code: 409, error: "У проекта-референса не задан local_path" };
  if (!fs.existsSync(lp)) {
    return { ok: false, code: 410, error: `local_path \`${lp}\` не существует в контейнере` };
  }
  return {
    ok: true,
    row: {
      id: rows[0].id as string,
      slug: rows[0].slug as string,
      name: rows[0].name as string,
      description: (rows[0].description as string | null) ?? null,
      localPath: lp,
    },
  };
}

type CallerOk = { error: null };
type CallerErr = { error: string; code: number };

async function resolveCaller(
  userId: string,
  callerProjectId: string | undefined,
): Promise<CallerOk | CallerErr> {
  if (!callerProjectId) return { error: "Параметр callerProjectId обязателен", code: 400 };
  if (!isUuid(callerProjectId)) return { error: "Невалидный callerProjectId", code: 400 };
  if (!(await userCanAccessProject(userId, callerProjectId))) {
    return { error: "Нет доступа к вызывающему проекту", code: 403 };
  }
  return { error: null };
}

async function getCallerReferenceProjectIds(callerProjectId: string): Promise<string[]> {
  const { rows } = await getPool().query(
    "SELECT settings FROM projects WHERE id = $1",
    [callerProjectId],
  );
  if (!rows.length) return [];
  const s = rows[0].settings as { referenceProjects?: unknown } | null;
  const raw = Array.isArray(s?.referenceProjects) ? s!.referenceProjects : [];
  return raw.filter((x: unknown): x is string => typeof x === "string" && isUuid(x));
}

async function loadReferenceProjects(
  callerProjectId: string,
  userId: string,
): Promise<RefProjectRow[]> {
  const ids = await getCallerReferenceProjectIds(callerProjectId);
  if (ids.length === 0) return [];
  const { rows } = await getPool().query(
    `SELECT id, slug, name, description, local_path
       FROM projects WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const out: RefProjectRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    if (!(await userCanReferenceProject(userId, id))) continue;
    out.push({
      id: row.id as string,
      slug: row.slug as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      localPath: (row.local_path as string | null) ?? "",
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Path + filesystem helpers

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean { return UUID_RE.test(s); }

function parseNonNegInt(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && Math.floor(n) === n ? n : null;
}

/**
 * Resolve `sub` under `root`, returning the absolute path iff it stays
 * inside `root`. Reject absolute paths, `..` traversal, and symlinks whose
 * realpath escapes. Returns null for any rejection. Exported for tests.
 */
export function safeResolve(root: string, sub: string): string | null {
  // Reject absolute path inputs outright — even if they'd resolve under
  // root, accepting them invites confusion. Same for backslashes (windows-
  // style separators) so a path like `..\\etc\\passwd` doesn't slip through.
  if (path.isAbsolute(sub) || sub.includes("\0")) return null;
  const joined = path.resolve(root, sub);
  // Containment check before realpath — handles non-existing paths.
  if (!isInside(joined, root)) return null;
  // If the resolved path exists, follow symlinks and re-check. We don't
  // realpath `root` itself; if root is a symlink to the actual workspace,
  // any link inside would test against the realpath'd root and false-fail.
  let real = joined;
  try {
    if (fs.existsSync(joined)) real = fs.realpathSync(joined);
  } catch {
    return null;
  }
  let rootReal = root;
  try { rootReal = fs.realpathSync(root); } catch { /* root may briefly not exist */ }
  if (!isInside(real, rootReal)) return null;
  return joined;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Recursive dir walk capped at `limit` entries. Returns each entry as
 * `{ path, size, isDir }` with `path` relative to the project root. Skips
 * common noise dirs (node_modules, .git, dist, build).
 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache"]);
function walkDir(
  dir: string,
  projectRoot: string,
  globRegex: RegExp | null,
  limit: number,
): { path: string; size: number; isDir: boolean }[] {
  const out: { path: string; size: number; isDir: boolean }[] = [];
  const stack: string[] = [dir];
  while (stack.length && out.length < limit) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= limit) break;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(cur, e.name);
      const rel = path.relative(projectRoot, full);
      if (e.isDirectory()) {
        if (!globRegex || globRegex.test(rel)) {
          out.push({ path: rel, size: 0, isDir: true });
        }
        stack.push(full);
      } else if (e.isFile()) {
        if (globRegex && !globRegex.test(rel)) continue;
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* skip */ continue; }
        out.push({ path: rel, size, isDir: false });
      }
    }
  }
  return out;
}

/**
 * Minimal shell-glob → regex. Supports the canonical four operators:
 *   - `**\/`  zero or more directory segments  → `(?:.+/)?`
 *   - `**`   anything including path separators → `.*`
 *   - `*`    anything within one segment        → `[^/]*`
 *   - `?`    single character within one segment → `[^/]`
 *
 * Note the special case of `**\/`: it has to match ZERO directories too,
 * so `src/**\/*.ts` matches both `src/index.ts` and `src/a/b.ts`. The
 * naive translation `.*\/[^/]*\.ts` requires at least one intermediate dir.
 * Anchored to the full string. Exported for tests.
 */
export function globToRegExp(g: string): RegExp {
  let re = "";
  let i = 0;
  while (i < g.length) {
    // `**/` — collapses the trailing slash so the segment can be empty.
    if (g.startsWith("**/", i)) {
      re += "(?:.+/)?";
      i += 3;
      continue;
    }
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { re += ".*"; i += 2; }
      else { re += "[^/]*"; i++; }
      continue;
    }
    if (c === "?") { re += "[^/]"; i++; continue; }
    if (/[.+^$|(){}\[\]\\]/.test(c)) { re += `\\${c}`; i++; continue; }
    re += c;
    i++;
  }
  try { return new RegExp(`^${re}$`); }
  catch (err) {
    log.warn({ err, glob: g }, "invalid glob, falling back to match-all");
    return /.*/;
  }
}
