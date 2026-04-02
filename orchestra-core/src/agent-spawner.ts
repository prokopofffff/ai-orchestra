import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { type Config, type AgentRole, getModelForRole } from "./config.js";
import { createSession, updateSession, type Session } from "./session-manager.js";
import { appendLog } from "./logger.js";
import { notify } from "./notification-hub.js";
import { buildBootstrapContext, formatBootstrapPrompt } from "./session-context.js";
import { generateMcpConfig } from "./mcp-config-generator.js";
import { getPool } from "./db.js";

// ─── Scope Rules ───

const scopeRules: Record<AgentRole, { allowed: string[]; denied: string[] }> = {
  "tech-lead": { allowed: ["**/*"], denied: [] },
  designer: { allowed: ["design/**", "*.pen", "STYLE.md"], denied: ["src/**"] },
  frontend: { allowed: ["src/frontend/**", "src/shared/types/**", "public/**"], denied: ["src/backend/**", "src/api/**", "database/**"] },
  backend: { allowed: ["src/backend/**", "src/api/**", "database/**", "src/shared/types/**"], denied: ["src/frontend/**", "public/**"] },
  qa: { allowed: ["tests/**", "e2e/**"], denied: [] },
  devops: { allowed: [".github/**", "docker-compose.yml", "Dockerfile", "ci/**"], denied: [] },
};

// ─── Branch naming ───

function branchName(role: AgentRole, taskId: string): string {
  const prefixes: Record<AgentRole, string> = {
    "tech-lead": "chore",
    designer: "design",
    frontend: "feature/frontend",
    backend: "feature/backend",
    qa: "test",
    devops: "ci",
  };
  return `${prefixes[role]}/${taskId}`;
}

// ─── Workspace paths ───

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT
  ?? path.join(process.env.HOME ?? "/tmp", "orchestra-workspaces");

function workspacePath(projectSlug: string): string {
  return path.join(WORKSPACES_ROOT, projectSlug);
}

// ─── Git operations ───

async function exec(cmd: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
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

async function ensureRepo(repoUrl: string, projectSlug: string): Promise<string> {
  const repoDir = path.join(workspacePath(projectSlug), "repo");

  if (fs.existsSync(path.join(repoDir, ".git"))) {
    // Fetch and update local main from remote
    try {
      await exec("git remote get-url origin", repoDir);
      await exec("git fetch origin", repoDir);
      await exec("git checkout main && git pull origin main", repoDir);
    } catch { /* local repo or no remote */ }
    return repoDir;
  }

  fs.mkdirSync(path.dirname(repoDir), { recursive: true });

  // Inject GitHub token into URL if available
  let cloneUrl = repoUrl;
  const token = process.env.GITHUB_TOKEN;
  if (token && cloneUrl.startsWith("https://github.com/")) {
    cloneUrl = cloneUrl.replace("https://github.com/", `https://${token}@github.com/`);
  }

  await exec(`git clone "${cloneUrl}" "${repoDir}"`);
  return repoDir;
}

async function createWorktree(repoDir: string, branch: string, defaultBranch: string): Promise<string> {
  const worktreeDir = path.join(path.dirname(repoDir), "worktrees", branch.replace(/\//g, "-"));

  // Clean up existing worktree if any
  if (fs.existsSync(worktreeDir)) {
    try { await exec(`git worktree remove "${worktreeDir}" --force`, repoDir); } catch { /* ignore */ }
  }

  // Determine base ref: prefer origin/main, fallback to local main/HEAD
  let baseRef = `origin/${defaultBranch}`;
  try {
    await exec(`git rev-parse --verify ${baseRef}`, repoDir);
  } catch {
    baseRef = defaultBranch; // Use local branch
  }

  // Create branch from base
  try {
    await exec(`git branch "${branch}" "${baseRef}"`, repoDir);
  } catch {
    // Branch might already exist — reset it
    try { await exec(`git branch -f "${branch}" "${baseRef}"`, repoDir); } catch { /* keep existing */ }
  }

  await exec(`git worktree add "${worktreeDir}" "${branch}"`, repoDir);
  return worktreeDir;
}

async function cleanupWorktree(repoDir: string, worktreeDir: string): Promise<void> {
  try {
    await exec(`git worktree remove "${worktreeDir}" --force`, repoDir);
  } catch { /* ignore */ }
}

// ─── Spawn Agent ───

export interface SpawnAgentParams {
  projectId: string;
  taskId: string;
  role: AgentRole;
  config: Config;
  resumeSessionId?: string;
}

export interface SpawnResult {
  session: Session;
  process: ChildProcess;
}

export async function spawnAgent(params: SpawnAgentParams): Promise<SpawnResult> {
  const { projectId, taskId, role, config } = params;
  const pool = getPool();

  // Get project info
  const { rows: projRows } = await pool.query("SELECT slug, repo_url, settings FROM projects WHERE id = $1", [projectId]);
  if (!projRows.length) throw new Error(`Project not found: ${projectId}`);
  const { slug, repo_url: repoUrl, settings } = projRows[0];

  if (!repoUrl) throw new Error(`Project ${slug} has no repository URL`);

  // Check blocked_by
  const { rows: taskRows } = await pool.query("SELECT blocked_by FROM tasks WHERE id = $1", [taskId]);
  if (taskRows.length && (taskRows[0].blocked_by as string[]).length > 0) {
    const blockers = taskRows[0].blocked_by as string[];
    const { rows: blockerRows } = await pool.query(
      "SELECT id FROM tasks WHERE id = ANY($1) AND state NOT IN ('merged', 'closed', 'design_ready', 'approved', 'tested')",
      [blockers],
    );
    if (blockerRows.length > 0) {
      throw new Error(`Task ${taskId} is blocked by ${blockerRows.length} unfinished task(s)`);
    }
  }

  // Determine model
  const model = getModelForRole(config, role, settings as Record<string, unknown>);

  // Ensure repo is cloned
  const repoDir = await ensureRepo(repoUrl, slug);

  // Create worktree
  const branch = branchName(role, taskId);
  const worktreeDir = await createWorktree(repoDir, branch, config.githubDefaultBranch);

  // Ensure remote origin is configured with auth for push
  const token = process.env.GITHUB_TOKEN;
  if (token && repoUrl.includes("github.com")) {
    const authUrl = repoUrl.replace("https://github.com/", `https://${token}@github.com/`);
    try {
      await exec(`git remote set-url origin "${authUrl}"`, worktreeDir);
    } catch {
      try { await exec(`git remote add origin "${authUrl}"`, worktreeDir); } catch { /* ignore */ }
    }
  }

  // Build bootstrap context
  const ctx = await buildBootstrapContext(projectId, role, taskId);
  const bootstrapPrompt = formatBootstrapPrompt(ctx);

  // Generate MCP config
  const mcpConfigPath = path.join(worktreeDir, ".mcp-agent.json");
  const mcpConfig = generateMcpConfig(role, config, projectId);
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

  // Read system prompt
  const promptPath = path.join(process.cwd(), "prompts", `${role === "tech-lead" ? "tech-lead" : role === "frontend" ? "dev-frontend" : role === "backend" ? "dev-backend" : role}.md`);
  let systemPrompt = "";
  if (fs.existsSync(promptPath)) {
    systemPrompt = fs.readFileSync(promptPath, "utf-8");
  }

  // Add scope rules to prompt
  const scope = scopeRules[role];
  const scopePrompt = [
    "\n## Scope Rules",
    `You may ONLY modify files in: ${scope.allowed.join(", ")}`,
    scope.denied.length ? `You must NOT modify files in: ${scope.denied.join(", ")}` : "",
    "You may delete unnecessary files within your allowed scope.",
    "Before creating a PR, run `git rebase main`. If there are conflicts, escalate to tech-lead.",
  ].filter(Boolean).join("\n");

  const fullPrompt = [systemPrompt, scopePrompt, "\n---\n", bootstrapPrompt].join("\n");

  // Create session in DB
  const session = await createSession({
    projectId,
    role,
    taskId,
    model,
    worktreePath: worktreeDir,
  });

  // Build Claude CLI command
  const args = [
    "--dangerously-skip-permissions",
    "--model", model,
    "--output-format", "text",
    "--mcp-config", mcpConfigPath,
    "-p", fullPrompt,
  ];

  if (params.resumeSessionId) {
    args.push("--resume", params.resumeSessionId);
  }

  // Spawn Claude Code process
  const proc = spawn("claude", args, {
    cwd: worktreeDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Update session with PID
  await updateSession(session.id, { pid: proc.pid ?? null });
  appendLog(projectId, session.id, role, "system", `Agent spawned: model=${model} worktree=${worktreeDir}`);

  // Capture output
  let output = "";
  proc.stdout?.on("data", (d) => {
    const chunk = d.toString();
    output += chunk;
    appendLog(projectId, session.id, role, "stdout", chunk);
  });
  proc.stderr?.on("data", (d) => {
    appendLog(projectId, session.id, role, "stderr", d.toString());
  });

  // Handle process exit
  proc.on("exit", async (code) => {
    const status = code === 0 ? "terminated" : "crashed";
    await updateSession(session.id, { status, finishedAt: new Date() });
    appendLog(projectId, session.id, role, "system", `Process exited with code ${code}`);

    // Notify about agent completion
    const taskTitle = (await getPool().query("SELECT title FROM tasks WHERE id = $1", [taskId])).rows[0]?.title;
    await notify({
      projectId,
      text: `Agent ${role} finished: ${taskTitle ?? taskId}`,
      priority: "low",
      fromRole: "system",
    }).catch(() => {});

    if (status === "terminated") {
      // Cleanup worktree, keep branch for PR
      try { await cleanupWorktree(repoDir, worktreeDir); } catch { /* ignore */ }
    }
  });

  return { session, process: proc };
}
