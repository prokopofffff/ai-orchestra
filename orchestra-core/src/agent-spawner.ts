import { type Config, type AgentRole, getModelForRole } from "./config";
import { createSession, type Session } from "./session-manager";
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
} from "./repo-manager";
import { installScopeHook } from "./scope-enforcer";
import { runAgentSdk } from "./agents/sdk-runner";
import { loadSystemPrompt, buildScopeRules, assemblePrompt } from "./agents/prompt";
import { providerFor } from "./providers";
import type { ProjectSettings } from "@ai-orchestra/shared";

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
  /** Set when the SDK aborted on a cap; downstream may freeze the task. */
  capExceeded?: { kind: "budget" | "timeout" | "aborted"; detail: string };
}

/**
 * Run an agent end-to-end:
 *   1. Resolve project + blocked_by + model
 *   2. Clone/fetch repo, create worktree, install scope git hook
 *   3. Build bootstrap prompt + per-role system prompt
 *   4. Generate MCP config + record session row
 *   5. Invoke the Agent SDK — awaits the full run; lease covers it
 *   6. Notify + cleanup worktree on exit
 */
export async function spawnAgent(params: SpawnAgentParams): Promise<SpawnResult> {
  const { projectId, taskId, role, config } = params;
  const pool = getPool();

  // ── 1. Project + blocked_by + model ─────────────────────────────────
  const { rows: projRows } = await pool.query(
    "SELECT slug, repo_url, local_path, settings FROM projects WHERE id = $1",
    [projectId],
  );
  if (!projRows.length) throw new Error(`Project not found: ${projectId}`);
  const { slug, repo_url: repoUrl, local_path: localPath, settings } = projRows[0];
  if (!repoUrl && !localPath) throw new Error(`Project ${slug} has no repository URL or local path — configure it in Settings`);

  // Apply any DB-stored auth overrides (set via UI) on top of env defaults.
  const { rows: sysRows } = await pool.query(
    "SELECT key, value FROM system_config WHERE key IN ('claude_auth', 'claude_api_key') LIMIT 2",
  ).catch(() => ({ rows: [] }));
  const sysConfig = Object.fromEntries((sysRows as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  if (sysConfig.claude_api_key && (sysConfig.claude_auth ?? config.claudeAuth) === "api") {
    process.env.ANTHROPIC_API_KEY = sysConfig.claude_api_key;
  }

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

  const model = getModelForRole(config, role, settings as Record<string, unknown>);

  // ── 2. Worktree + scope hook ────────────────────────────────────────
  let repoDir: string;
  let authUrl: string | null = null;
  if (localPath) {
    repoDir = localPath as string;
  } else {
    const provider = providerFor(repoUrl, settings as ProjectSettings | null);
    authUrl = provider.tokenizeCloneUrl();
    repoDir = await ensureRepo(authUrl, slug);
  }
  const branch = branchName(role, taskId);
  const worktreeDir = await createWorktree(repoDir, branch, config.githubDefaultBranch);
  if (authUrl) await configureRemoteAuth(worktreeDir, authUrl);
  installScopeHook(worktreeDir, role);

  // ── 3. Prompt ──────────────────────────────────────────────────────
  const fullPrompt = assemblePrompt({
    systemPrompt: loadSystemPrompt(role, { pencilEnabled: config.pencilEnabled }),
    scope: buildScopeRules(role),
    bootstrap: formatBootstrapPrompt(await buildBootstrapContext(projectId, role, taskId)),
  });

  // ── 4. Session row + MCP servers (passed inline to SDK) ─────────────
  const session = await createSession({ projectId, role, taskId, model, worktreePath: worktreeDir });
  const { mcpServers } = generateMcpConfig(role, config, projectId);
  appendLog(projectId, session.id, role, "system", `agent run: model=${model} worktree=${worktreeDir}`);

  // ── 5. SDK run (awaits the full agent) ──────────────────────────────
  let capExceeded: SpawnResult["capExceeded"];
  try {
    const outcome = await runAgentSdk({
      projectId,
      taskId,
      sessionId: session.id,
      role,
      model,
      worktree: worktreeDir,
      fullPrompt,
      mcpServers,
      settings,
      resumeSessionId: params.resumeSessionId,
    });
    capExceeded = outcome.capExceeded;
    if (capExceeded) {
      await pool.query(
        "UPDATE tasks SET frozen_reason = $1, updated_at = now() WHERE id = $2 AND frozen_reason IS NULL",
        [capExceeded.detail, taskId],
      );
    }
  } finally {
    // ── 6. Notify + cleanup ────────────────────────────────────────────
    const taskTitle = (await getPool().query("SELECT title FROM tasks WHERE id = $1", [taskId])).rows[0]?.title;
    await notify({
      projectId,
      text: `Agent ${role} finished: ${taskTitle ?? taskId}`,
      priority: "low",
      fromRole: "system",
    }).catch((e) => logBackgroundError("agent:notify-completion", e, projectId));
    await cleanupWorktree(repoDir, worktreeDir);
  }

  return { session, capExceeded };
}
