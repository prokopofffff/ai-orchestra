import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT
  ?? path.join(process.env.HOME ?? "/tmp", "orchestra-workspaces");

export function workspacePath(projectSlug: string): string {
  return path.join(WORKSPACES_ROOT, projectSlug);
}

export function getWorkspacesRoot(): string {
  return WORKSPACES_ROOT;
}

/**
 * Ensure a git repo is cloned and up-to-date. Returns the repo directory.
 * If repo already exists, fetches and pulls main. If not, clones.
 */
export async function ensureRepo(repoUrl: string, projectSlug: string): Promise<string> {
  const repoDir = path.join(workspacePath(projectSlug), "repo");

  if (fs.existsSync(path.join(repoDir, ".git"))) {
    try {
      await exec("git remote get-url origin", repoDir);
      await exec("git fetch origin", repoDir);
      await exec("git checkout main && git pull origin main", repoDir);
    } catch (e) {
      console.log(`[ensureRepo] git fetch/pull skipped: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
    return repoDir;
  }

  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  const cloneUrl = injectToken(repoUrl);
  await exec(`git clone "${cloneUrl}" "${repoDir}"`);
  return repoDir;
}

/**
 * Ensure a working directory exists (for projects without a git repo).
 */
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

  // Clean up stale worktree registrations
  await exec("git worktree prune", repoDir).catch(() => {});
  if (fs.existsSync(worktreeDir)) {
    try { await exec(`git worktree remove "${worktreeDir}" --force`, repoDir); } catch { /* may not exist */ }
  }

  // Determine base ref
  let baseRef = `origin/${defaultBranch}`;
  try {
    await exec(`git rev-parse --verify ${baseRef}`, repoDir);
  } catch {
    baseRef = defaultBranch;
  }

  // Create branch
  try {
    await exec(`git branch "${branch}" "${baseRef}"`, repoDir);
  } catch {
    try { await exec(`git branch -f "${branch}" "${baseRef}"`, repoDir); } catch { /* keep existing */ }
  }

  await exec(`git worktree add "${worktreeDir}" "${branch}"`, repoDir);
  return worktreeDir;
}

/**
 * Remove a git worktree (best-effort).
 */
export async function cleanupWorktree(repoDir: string, worktreeDir: string): Promise<void> {
  try {
    await exec(`git worktree remove "${worktreeDir}" --force`, repoDir);
  } catch { /* already removed */ }
}

/**
 * Configure remote origin with GitHub token for push access.
 */
export async function configureRemoteAuth(worktreeDir: string, repoUrl: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token || !repoUrl.includes("github.com")) return;

  const authUrl = injectToken(repoUrl);
  try {
    await exec(`git remote set-url origin "${authUrl}"`, worktreeDir);
  } catch {
    try { await exec(`git remote add origin "${authUrl}"`, worktreeDir); } catch { /* ignore */ }
  }
}

/**
 * Branch name convention per role.
 */
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

export function exec(cmd: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-c", cmd], { cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`Command failed (${code}): ${cmd}\n${stderr}`));
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
