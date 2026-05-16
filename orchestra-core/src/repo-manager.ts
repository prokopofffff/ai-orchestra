import fs from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { log } from "./obs";

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT
  ?? path.join(process.env.HOME ?? "/tmp", "orchestra-workspaces");

export function workspacePath(projectSlug: string): string {
  return path.join(WORKSPACES_ROOT, projectSlug);
}

export function getWorkspacesRoot(): string {
  return WORKSPACES_ROOT;
}

/** Open a simple-git instance against `cwd`. Convenience for callers that
 * want to issue ad-hoc git ops outside this module (pr-api uses it for diff). */
export function git(cwd: string): SimpleGit {
  return simpleGit(cwd);
}

/**
 * Ensure a git repo is cloned and up-to-date. Returns the repo directory.
 * If repo already exists, fetches and pulls main. If not, clones.
 *
 * `cloneUrl` must already have auth credentials baked in (see
 * `GitProvider.tokenizeCloneUrl()`). repo-manager stays provider-agnostic —
 * it doesn't know about GitHub vs GitLab token schemes.
 */
export async function ensureRepo(cloneUrl: string, projectSlug: string): Promise<string> {
  const repoDir = path.join(workspacePath(projectSlug), "repo");

  if (fs.existsSync(path.join(repoDir, ".git"))) {
    try {
      const g = simpleGit(repoDir);
      await g.remote(["get-url", "origin"]);
      await g.fetch("origin");
      await g.checkout("main");
      await g.pull("origin", "main");
    } catch (err) {
      log.warn({ err, repoDir }, "ensureRepo: fetch/pull skipped");
    }
    return repoDir;
  }

  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  await simpleGit().clone(cloneUrl, repoDir);
  return repoDir;
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
 */
export async function createWorktree(
  repoDir: string,
  branch: string,
  defaultBranch: string,
): Promise<string> {
  const worktreeDir = path.join(path.dirname(repoDir), "worktrees", branch.replace(/\//g, "-"));
  const g = simpleGit(repoDir);

  // Clean up stale worktree registrations.
  await g.raw(["worktree", "prune"]).catch(() => {});
  if (fs.existsSync(worktreeDir)) {
    await g.raw(["worktree", "remove", worktreeDir, "--force"]).catch(() => {});
  }

  // Pick base ref: prefer origin/<default>, else local <default>.
  let baseRef = `origin/${defaultBranch}`;
  try {
    await g.raw(["rev-parse", "--verify", baseRef]);
  } catch {
    baseRef = defaultBranch;
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

