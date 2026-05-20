import { type Config, type AgentRole, getEffortForRole } from "./config";
import {
  createSession,
  updateSession,
  registerSessionController,
  unregisterSessionController,
  type Session,
} from "./session-manager";
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
  isGitRepo,
} from "./repo-manager";
import { PreflightError } from "./error-handler";
import { installScopeHook } from "./scope-enforcer";
import { resolveRuntimeForRole } from "./agents/runtime/resolver";
import {
  logRuntimeEvent,
  enqueueObserveCheck,
  recordRuntimeCost,
  type ObserverContext,
} from "./agents/runtime/observers";
import { providerFor } from "./providers";
import { mintAgentJwt } from "./agent-jwt";
import { assertWithinDailyCap, assertWithinOrchestraDailyCap, CostCapExceeded } from "./cost-tracker";
import { DONE_STATES } from "./dependency-engine";
import { resolveDailyCostCap, resolvePerRunBudgetUsd } from "./limits";
import { escalate } from "./notification-hub";
import type { ProjectSettings } from "@ai-orchestra/shared";
import type { RuntimeEvent } from "./agents/runtime/types";

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
  if (!repoUrl && !localPath) {
    // Same shape as the "not a git repo" preflight — the user has an
    // actionable fix (set a repo URL or local path in Settings), so
    // escalate cleanly instead of logging a [agent-run] fatal.
    const reason = `У проекта "${slug}" не задан репозиторий или локальный путь. Откройте Настройки проекта, чтобы указать его.`;
    await escalate(projectId, taskId, reason, {
      event: "no_repo_configured",
      slug,
      role,
    });
    throw new PreflightError(`no repo/local_path on project ${slug}`);
  }

  // Resolve which runtime + model + auth env to use for this (project, role).
  // The resolver picks Claude vs Codex based on settings.models[role] and
  // builds the per-spawn env vars (CLAUDE_CONFIG_DIR / CODEX_HOME /
  // ANTHROPIC_API_KEY) — no global env mutation.
  const resolved = await resolveRuntimeForRole({
    projectId, role, settings, config,
  });
  if (!resolved.ok) {
    await escalate(projectId, taskId, resolved.reason, {
      event: "runtime_auth_unconfigured", slug, role,
    });
    throw new PreflightError(`runtime auth unconfigured on project ${slug}: ${resolved.reason}`);
  }

  const { rows: taskRows } = await pool.query("SELECT blocked_by FROM tasks WHERE id = $1", [taskId]);
  if (taskRows.length && (taskRows[0].blocked_by as string[]).length > 0) {
    const blockers = taskRows[0].blocked_by as string[];
    const placeholders = DONE_STATES.map((_, i) => `$${i + 2}`).join(", ");
    const { rows: blockerRows } = await pool.query(
      `SELECT id FROM tasks WHERE id = ANY($1) AND state NOT IN (${placeholders})`,
      [blockers, ...DONE_STATES],
    );
    if (blockerRows.length > 0) {
      throw new Error(`Task ${taskId} is blocked by ${blockerRows.length} unfinished task(s)`);
    }
  }

  // Provider-stripped model (e.g. "opus" for "claude:opus", "gpt-5-codex"
  // for "codex:gpt-5-codex"). Falls back to whatever getModelForRole would
  // have returned if no provider was specified. Recorded on the session row.
  const model = resolved.resolved.model;
  const effort = getEffortForRole(role, settings as Record<string, unknown>);

  // ── 1b. Orchestra-wide + per-project daily cost cap gate ────────────
  // Hit before any worktree/IO so a tripped cap is cheap. cap=0 → unlimited.
  // Orchestra-wide first so a global cap can shut everything down even when
  // individual projects are configured generously.
  try {
    await assertWithinOrchestraDailyCap();
    await assertWithinDailyCap(projectId, resolveDailyCostCap(settings));
  } catch (err) {
    if (err instanceof CostCapExceeded) {
      await escalate(
        projectId, taskId,
        `Daily cost cap reached: $${err.spent.toFixed(2)} / $${err.cap.toFixed(2)} — agent ${role} not started`,
        { event: "daily_cost_cap", role, spent: err.spent, cap: err.cap },
      );
    }
    throw err;
  }

  // ── 2. Worktree + scope hook ────────────────────────────────────────
  let repoDir: string;
  let authUrl: string | null = null;
  if (localPath) {
    repoDir = localPath as string;
    // Preflight: agents work in git worktrees, so the local path has to
    // actually be a git repo. If it isn't, escalate to the user with an
    // actionable message (the dashboard surfaces an "Initialize git here"
    // button on the Settings → Project tab) and bail out cleanly —
    // PreflightError keeps this out of the [agent-run] fatal log.
    if (!isGitRepo(repoDir)) {
      const reason = `Локальный путь \`${repoDir}\` не является git-репозиторием. Откройте Настройки проекта, чтобы инициализировать его, или укажите другой путь.`;
      await escalate(projectId, taskId, reason, {
        event: "not_a_git_repo",
        path: repoDir,
        role,
      });
      throw new PreflightError(`not a git repo: ${repoDir}`);
    }
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
  // Static role identity / scope / rules live on the SDK agent definition
  // (role-definitions.ts). Here we build only the dynamic per-run context
  // — task, signals, current project state — which goes in as the first
  // user turn.
  const bootstrap = formatBootstrapPrompt(await buildBootstrapContext(projectId, role, taskId));

  // ── 4. Session row + MCP servers (passed inline to SDK) ─────────────
  const session = await createSession({ projectId, role, taskId, model, worktreePath: worktreeDir });
  const agentJwt = await mintAgentJwt(projectId);
  const { mcpServers } = generateMcpConfig(role, config, projectId, agentJwt);
  appendLog(projectId, session.id, role, "system", `agent run: model=${model} worktree=${worktreeDir}`);

  // ── 5. Runtime run (awaits the full agent) ──────────────────────────
  // The runtime drives the `claude` CLI in headless stream-json mode and
  // delivers normalized RuntimeEvents to our observer. What used to be
  // in-process SDK callbacks (PostToolUse, canUseTool) now lives either
  // in the per-worktree settings.json (sandbox + permissions.deny) or as
  // observer logic right here (logging, observe-check enqueue, cost).
  const abortController = new AbortController();
  registerSessionController(session.id, abortController);

  const maxBudgetUsd = resolvePerRunBudgetUsd(role, settings);
  const ctx: ObserverContext = {
    projectId,
    sessionId: session.id,
    taskId,
    role,
    worktree: worktreeDir,
  };
  const onEvent = async (evt: RuntimeEvent): Promise<void> => {
    logRuntimeEvent(ctx, evt);
    await enqueueObserveCheck(ctx, evt).catch((e) =>
      logBackgroundError("spawner:observe-check", e, projectId));
    await recordRuntimeCost(ctx, evt, { maxBudgetUsd });
  };

  let capExceeded: SpawnResult["capExceeded"];
  try {
    appendLog(projectId, session.id, role, "system",
      `runtime run: provider=${resolved.resolved.provider} model=${model} effort=${effort ?? "(default)"} worktree=${worktreeDir} budget=$${maxBudgetUsd}`);
    const outcome = await resolved.resolved.runtime.run({
      projectId,
      taskId,
      sessionId: session.id,
      role,
      model,
      effort,
      cwd: worktreeDir,
      prompt: bootstrap,
      pencilEnabled: config.pencilEnabled,
      mcpServers,
      settings,
      resumeSessionId: params.resumeSessionId,
      abortSignal: abortController.signal,
      spawnEnv: resolved.resolved.spawnEnv,
    }, onEvent);
    capExceeded = outcome.capExceeded;
    if (capExceeded) {
      // Surface timeouts as an escalation here — the runtime can't see the
      // task context. Budget caps already escalated in recordRuntimeCost.
      if (capExceeded.kind === "timeout") {
        await escalate(projectId, taskId,
          `Агент ${role} превысил таймаут на задаче ${taskId}: ${capExceeded.detail}`,
          { event: "run_timeout", role, sessionId: session.id }
        ).catch((e) => logBackgroundError("spawner:timeout-escalate", e, projectId));
      }
      await pool.query(
        "UPDATE tasks SET frozen_reason = $1, updated_at = now() WHERE id = $2 AND frozen_reason IS NULL",
        [capExceeded.detail, taskId],
      );
      await updateSession(session.id, {
        status: capExceeded.kind === "aborted" ? "crashed" : "terminated",
        finishedAt: new Date(),
      });
    } else {
      await updateSession(session.id, { status: "terminated", finishedAt: new Date() });
    }
    appendLog(projectId, session.id, role, "system", "runtime run completed");
  } catch (err) {
    await updateSession(session.id, { status: "crashed", finishedAt: new Date() });
    appendLog(projectId, session.id, role, "error",
      `runtime run failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    unregisterSessionController(session.id);
    // ── 6. Notify + cleanup ────────────────────────────────────────────
    const taskTitle = (await getPool().query("SELECT title FROM tasks WHERE id = $1", [taskId])).rows[0]?.title;
    await notify({
      projectId,
      text: `Агент ${role} завершил работу: ${taskTitle ?? taskId}`,
      priority: "low",
      fromRole: "system",
    }).catch((e) => logBackgroundError("agent:notify-completion", e, projectId));
    await cleanupWorktree(repoDir, worktreeDir);
  }

  return { session, capExceeded };
}
