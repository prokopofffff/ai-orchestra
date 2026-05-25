import path from "node:path";

/**
 * Per-user workspace scoping. In a multi-tenant install every project's
 * `localPath` must live inside `<root>/<userId>/…` so:
 *
 *   1. The FolderPicker can't be coaxed into listing someone else's tree.
 *   2. A clone operation can never write outside the requesting user's
 *      subtree, even if the user supplies a hand-crafted absolute path.
 *   3. Volume mounts on the deploy host map `<root>` to a persistent
 *      volume — every user automatically gets their own subdir on first
 *      use without ops doing anything.
 *
 * Single canonical env: `ORCHESTRA_WORKSPACES_ROOT`. Legacy `WORKSPACES_ROOT`
 * and `WORKSPACE_ROOT` are accepted as fallbacks so existing .env files
 * keep working through the transition. On a dev laptop with none of these
 * set, default to `$HOME/orchestra-workspaces` so the picker has somewhere
 * predictable to land.
 */

export function getWorkspacesRoot(): string {
  const raw = process.env.ORCHESTRA_WORKSPACES_ROOT
    ?? process.env.WORKSPACES_ROOT
    ?? process.env.WORKSPACE_ROOT
    ?? path.join(process.env.HOME ?? "/tmp", "orchestra-workspaces");
  return path.resolve(raw);
}

/**
 * Per-user subtree. The userId is opaque to the filesystem — UUIDs from
 * `users.id` get stringified as-is. We do not slugify because the DB
 * already guarantees uniqueness and we want collisions to be impossible.
 */
export function getUserWorkspaceRoot(userId: string): string {
  if (!userId || userId.includes("/") || userId.includes("\\") || userId === "." || userId === "..") {
    throw new Error(`getUserWorkspaceRoot: invalid userId "${userId}"`);
  }
  return path.join(getWorkspacesRoot(), userId);
}

/**
 * Returns true if `absPath` is the user's scope dir or any descendant.
 * Uses `path.relative` so symlink-style traversals (`/a/b/../c`) get
 * normalized before the prefix check. Caller has already `path.resolve`'d
 * the input.
 */
export function isPathInUserScope(userId: string, absPath: string): boolean {
  const root = getUserWorkspaceRoot(userId);
  if (absPath === root) return true;
  const rel = path.relative(root, absPath);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Throws with a 403-ready message if the path is outside the user's scope.
 * Callers in route handlers should map this to `reply.code(403)`.
 */
export function assertPathInUserScope(userId: string, absPath: string): void {
  if (!isPathInUserScope(userId, absPath)) {
    throw new ScopeViolationError(
      `Путь должен быть внутри вашей рабочей директории (${getUserWorkspaceRoot(userId)}). Получено: ${absPath}`,
    );
  }
}

export class ScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeViolationError";
  }
}
