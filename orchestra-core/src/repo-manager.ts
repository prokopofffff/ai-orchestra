import fs from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { log } from "./obs";
import { getWorkspacesRoot } from "./workspace-scope";

/**
 * Legacy auto-derived path: `<root>/<slug>` (no per-user layer). Kept so
 * existing projects whose `localPath` got backfilled to this path keep
 * resolving. New projects route through workspace-scope.getUserWorkspaceRoot.
 */
export function workspacePath(projectSlug: string): string {
  return path.join(getWorkspacesRoot(), projectSlug);
}

export { getWorkspacesRoot };

/** Open a simple-git instance against `cwd`. Convenience for callers that
 * want to issue ad-hoc git ops outside this module (pr-api uses it for diff). */
export function git(cwd: string): SimpleGit {
  return simpleGit(cwd);
}

/**
 * Ensure a git repo is at `targetPath`, cloning if absent and fetch+pulling
 * if present. Returns `targetPath` so callers can chain.
 *
 * `cloneUrl` must already have auth credentials baked in (see
 * `GitProvider.tokenizeCloneUrl()`). repo-manager stays provider-agnostic —
 * it doesn't know about GitHub vs GitLab token schemes.
 *
 * `targetPath` is the absolute on-disk destination — `project.localPath`
 * for new-flow projects (user chose where it lives), or the legacy
 * `workspacePath(slug)/repo` for pre-clone-into-localPath projects (caller
 * derives this until the boot-time migration completes).
 */
export async function ensureRepo(cloneUrl: string, targetPath: string): Promise<string> {
  if (fs.existsSync(path.join(targetPath, ".git"))) {
    try {
      const g = simpleGit(targetPath);
      await g.remote(["get-url", "origin"]);
      await g.fetch("origin");
      await g.checkout("main");
      await g.pull("origin", "main");
    } catch (err) {
      log.warn({ err, targetPath }, "ensureRepo: fetch/pull skipped");
    }
    return targetPath;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  await simpleGit().clone(cloneUrl, targetPath);
  return targetPath;
}

/**
 * Legacy auto-derived path for projects whose `local_path` hasn't been
 * backfilled yet. New projects compute their own path and pass it directly
 * to `ensureRepo`. Once the boot migration sets `local_path` on every row
 * this helper can be retired.
 */
export function defaultRepoDir(projectSlug: string): string {
  return path.join(workspacePath(projectSlug), "repo");
}

/**
 * Cheap sync probe for "is this directory a git repo we can operate on?".
 * Worktree-aware: inside a checkout, `.git` is a file pointing at the
 * primary; we accept both. Returns false for non-existent paths and for
 * directories without a `.git` entry at all (the user pointed us at a
 * folder that hasn't been initialized yet).
 */
export function isGitRepo(p: string): boolean {
  const dotGit = path.join(p, ".git");
  return fs.existsSync(dotGit);
}

/**
 * Initialize a fresh git repo at `p`. Creates an initial empty commit so
 * `git worktree add` has a base ref to branch from. No-op if the path
 * is already a repo. Safe to call repeatedly.
 */
export async function initGitRepo(p: string, defaultBranch: string): Promise<void> {
  if (isGitRepo(p)) return;
  if (!fs.existsSync(p)) {
    throw new Error(`Path does not exist: ${p}`);
  }
  const g = simpleGit(p);
  await g.init([`--initial-branch=${defaultBranch}`]);
  // Empty commit so worktree add can base off this branch. Author info
  // is pulled from the user's global git config; if absent we fall back
  // to a sane placeholder so init doesn't error out on a vanilla machine.
  try {
    await g.raw(["config", "user.email"]);
  } catch {
    await g.addConfig("user.email", "orchestra@localhost");
    await g.addConfig("user.name", "AI Orchestra");
  }
  await g.commit("Initial commit", undefined, { "--allow-empty": null });
}

/** Ensure a working directory exists (for projects without a git repo). */
export function ensureTempDir(projectSlug: string): string {
  const dir = path.join(workspacePath(projectSlug), "workspace");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a git worktree for a branch. Prunes stale registrations first.
 *
 * `baseBranch` (optional): override the branch the new worktree branches
 * off of. Without this every worktree forks from `origin/<defaultBranch>`,
 * which is wrong for QA: QA spawned on a `pr_created` task with the dev's
 * branch already pushed needs to see the dev's code, not the pre-RAG
 * trunk. Callers pass `task.branchName` here when present. The function
 * verifies the ref actually exists (origin/ or local) before using it —
 * a typo or stale ref silently falls back to defaultBranch instead of
 * blowing up the spawn.
 */
export async function createWorktree(
  repoDir: string,
  branch: string,
  defaultBranch: string,
  baseBranch?: string | null,
): Promise<string> {
  const worktreeDir = path.join(path.dirname(repoDir), "worktrees", branch.replace(/\//g, "-"));
  const g = simpleGit(repoDir);

  // Clean up stale worktree registrations.
  await g.raw(["worktree", "prune"]).catch(() => {});
  if (fs.existsSync(worktreeDir)) {
    await g.raw(["worktree", "remove", worktreeDir, "--force"]).catch(() => {});
  }

  // Fetch origin so the base ref reflects the latest main. Without this,
  // a freshly-spawned agent can branch off a stale commit and produce a
  // PR that loses (or rebases away) recent changes from teammates. We
  // best-effort it: an offline / unauthenticated checkout still gets a
  // worktree off the local default branch — same fallback as before.
  await g.fetch("origin").catch((err) => {
    log.warn({ err, repoDir }, "createWorktree: fetch origin failed, using local refs");
  });

  // Pick base ref: caller's baseBranch (if it actually exists) → its
  // origin/ counterpart → origin/<default> → local <default>. The
  // verify-before-use pattern means a stale or mistyped branch silently
  // degrades to default instead of failing the spawn.
  const candidates: string[] = [];
  if (baseBranch && baseBranch !== branch) {
    candidates.push(`origin/${baseBranch}`, baseBranch);
  }
  candidates.push(`origin/${defaultBranch}`, defaultBranch);

  let baseRef = defaultBranch;
  for (const cand of candidates) {
    try {
      await g.raw(["rev-parse", "--verify", cand]);
      baseRef = cand;
      break;
    } catch { /* try next */ }
  }

  // Create or force-update branch.
  try {
    await g.raw(["branch", branch, baseRef]);
  } catch {
    await g.raw(["branch", "-f", branch, baseRef]).catch(() => { /* keep existing */ });
  }

  await g.raw(["worktree", "add", worktreeDir, branch]);
  return worktreeDir;
}

/** Remove a git worktree (best-effort). */
export async function cleanupWorktree(repoDir: string, worktreeDir: string): Promise<void> {
  await simpleGit(repoDir)
    .raw(["worktree", "remove", worktreeDir, "--force"])
    .catch(() => { /* already removed */ });
}

/**
 * Set the worktree's origin remote to a URL with auth credentials baked in.
 * Caller is responsible for generating `authUrl` via the right provider
 * (see `GitProvider.tokenizeCloneUrl()`).
 */
export async function configureRemoteAuth(worktreeDir: string, authUrl: string): Promise<void> {
  const g = simpleGit(worktreeDir);
  try {
    await g.remote(["set-url", "origin", authUrl]);
  } catch {
    await g.remote(["add", "origin", authUrl]).catch(() => { /* ignore */ });
  }
}

/**
 * Re-write origin's URL with the project's tokenized form. Idempotent.
 * Use after the user updates their git token in Settings so a pre-existing
 * local checkout's bare HTTPS remote (`https://host/path.git`) gains the
 * `oauth2:<token>@` (GitLab) / `<token>@` (GitHub) prefix that lets `git push`
 * authenticate without a credential helper. Without this, pushes from the
 * agent fail with `could not read Username for 'https://…': No such device
 * or address`.
 *
 * No-op (returns false) when the path isn't a git repo or when there's no
 * configured token/URL to apply. Errors during set-url are logged and
 * swallowed so a transient git permission issue can't bubble up and block
 * the settings save.
 */
export async function rewriteOriginAuth(
  repoDir: string,
  authUrl: string,
): Promise<boolean> {
  if (!isGitRepo(repoDir)) return false;
  try {
    await simpleGit(repoDir).remote(["set-url", "origin", authUrl]);
    return true;
  } catch (err) {
    log.warn({ err, repoDir }, "rewriteOriginAuth: set-url origin failed");
    return false;
  }
}

/** Branch name convention per role. */
export function branchName(role: string, taskId: string): string {
  const prefixes: Record<string, string> = {
    "tech-lead": "chore",
    designer: "design",
    frontend: "feature/frontend",
    backend: "feature/backend",
    qa: "test",
    devops: "ci",
  };
  return `${prefixes[role] ?? "work"}/${taskId}`;
}

