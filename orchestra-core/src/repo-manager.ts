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
 */
export async function ensureRepo(repoUrl: string, projectSlug: string): Promise<string> {
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
  const cloneUrl = injectToken(repoUrl);
  await simpleGit().clone(cloneUrl, repoDir);
  return repoDir;
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

/** Configure remote origin with GitHub token for push access. */
export async function configureRemoteAuth(worktreeDir: string, repoUrl: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token || !repoUrl.includes("github.com")) return;

  const authUrl = injectToken(repoUrl);
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

// ─── Internal helpers ───

function injectToken(repoUrl: string): string {
  const token = process.env.GITHUB_TOKEN;
  if (token && repoUrl.startsWith("https://github.com/")) {
    return repoUrl.replace("https://github.com/", `https://${token}@github.com/`);
  }
  return repoUrl;
}
