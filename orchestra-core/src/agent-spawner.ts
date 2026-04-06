import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { type Config, type AgentRole, getModelForRole } from "./config";
import { createSession, updateSession, type Session } from "./session-manager";
import { appendLog } from "./logger";
import { notify } from "./notification-hub";
import { logBackgroundError } from "./error-handler";
import { buildBootstrapContext, formatBootstrapPrompt } from "./session-context";
import { generateMcpConfig } from "./mcp-config-generator";
import { getPool } from "./db";
import {
  ensureRepo,
  createWorktree,
  cleanupWorktree,
  configureRemoteAuth,
  branchName,
  workspacePath,
} from "./repo-manager";

// ─── Scope Rules ───

const scopeRules: Record<AgentRole, { allowed: string[]; denied: string[] }> = {
  "tech-lead": { allowed: ["**/*"], denied: [] },
  designer: { allowed: ["design/**", "*.pen", "STYLE.md"], denied: ["src/**"] },
  frontend: { allowed: ["src/frontend/**", "src/shared/types/**", "public/**"], denied: ["src/backend/**", "src/api/**", "database/**"] },
  backend: { allowed: ["src/backend/**", "src/api/**", "database/**", "src/shared/types/**"], denied: ["src/frontend/**", "public/**"] },
  qa: { allowed: ["tests/**", "e2e/**", "**/*.config.*", "**/*.test.*", "**/*.spec.*", "package.json"], denied: [] },
  devops: { allowed: [".github/**", "docker-compose.yml", "Dockerfile", "ci/**"], denied: [] },
};

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
      "SELECT id FROM tasks WHERE id = ANY($1) AND state NOT IN ('tested', 'approved', 'merged', 'closed', 'design_ready')",
      [blockers],
    );
    if (blockerRows.length > 0) {
      throw new Error(`Task ${taskId} is blocked by ${blockerRows.length} unfinished task(s)`);
    }
  }

  // Determine model
  const model = getModelForRole(config, role, settings as Record<string, unknown>);

  // Ensure repo + worktree
  const repoDir = await ensureRepo(repoUrl, slug);
  const branch = branchName(role, taskId);
  const worktreeDir = await createWorktree(repoDir, branch, config.githubDefaultBranch);
  await configureRemoteAuth(worktreeDir, repoUrl);

  // Build bootstrap context
  const ctx = await buildBootstrapContext(projectId, role, taskId);
  const bootstrapPrompt = formatBootstrapPrompt(ctx);

  // Generate MCP config (outside worktree so git operations don't delete it)
  const mcpConfigDir = path.join(workspacePath(slug), ".mcp-configs");
  fs.mkdirSync(mcpConfigDir, { recursive: true });
  const mcpConfigPath = path.join(mcpConfigDir, `${role}-${taskId}.json`);
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
    }).catch((e) => logBackgroundError("agent:notify-completion", e, projectId));

    if (status === "terminated") {
      await cleanupWorktree(repoDir, worktreeDir);
    }
  });

  return { session, process: proc };
}
