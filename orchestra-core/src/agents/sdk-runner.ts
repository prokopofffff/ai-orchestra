import {
  query,
  type Options,
  type SDKMessage,
  type CanUseTool,
  type PostToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { minimatch } from "minimatch";
import { appendLog } from "../logger";
import { updateSession, registerSessionController, unregisterSessionController } from "../session-manager";
import { enqueue } from "../scheduler";
import { CHECK_KIND } from "./check-handlers";
import { getAgentConfig } from "./configs";
import { buildAgentDefinitions } from "./role-definitions";
import { recordCost } from "../cost-tracker";
import { resolvePerRunBudgetUsd, resolveRunTimeoutMs } from "../limits";
import { logBackgroundError } from "../error-handler";
import { escalate } from "../notification-hub";
import type { AgentRole } from "../config";

export type SdkRunInput = {
  projectId: string;
  taskId: string;
  sessionId: string;
  role: AgentRole;
  model: string;
  /** SDK effort level. Omit → SDK default ("high"). `max` is Opus-only. */
  effort?: "low" | "medium" | "high" | "max";
  worktree: string;
  /**
   * Dynamic per-run context that goes in as the first user turn:
   * task title/description, pending signals, project task list.
   * The static role identity / scope / rules live on the agent's
   * `prompt` field, built by buildAgentDefinitions().
   */
  bootstrap: string;
  /** Pencil plugin enabled? Designer prompt has a fallback variant when not. */
  pencilEnabled?: boolean;
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  /** Project settings (used to resolve per-run budget). */
  settings?: unknown;
  resumeSessionId?: string;
};

/**
 * Outcome of a run, surfaced to the caller (agent-spawner) so it can take
 * follow-up actions like freezing the task on a budget breach.
 */
export type SdkRunOutcome = {
  /** Set when the run aborted due to a cap rather than completing normally. */
  capExceeded?: { kind: "budget" | "timeout" | "aborted"; detail: string };
};

/**
 * Execute an agent run via the Claude Agent SDK.
 *
 * Awaits the full run; the caller (rate-limiter handler) holds the scheduler
 * lease for the duration. On crash mid-run, the lease expires and the job
 * re-claims — at which point `resumeSessionId` lets us pick up where we left off.
 */
export async function runAgentSdk(p: SdkRunInput): Promise<SdkRunOutcome> {
  const cfg = getAgentConfig(p.role);
  const outcome: SdkRunOutcome = {};

  const abortController = new AbortController();
  registerSessionController(p.sessionId, abortController);

  const maxBudgetUsd = resolvePerRunBudgetUsd(p.role, p.settings);
  const runTimeoutMs = resolveRunTimeoutMs(p.role, p.settings);

  // Watchdog: any run that exceeds its role's timeout is aborted via the
  // shared controller. SDK then surfaces an aborted-streaming terminal_reason
  // and we throw out of the for-await below.
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    abortController.abort(`run timeout after ${runTimeoutMs}ms`);
  }, runTimeoutMs);

  // SDK-native role config. The agent's prompt/skills/memory/disallowedTools
  // come from role-definitions.ts; we only need to plumb the runtime
  // bits (model, abort, budget, mcp) at the top level. Selecting `agent`
  // by role makes the SDK apply that definition's prompt + tool gates
  // automatically.
  const agents = buildAgentDefinitions({ pencilEnabled: p.pencilEnabled });

  const options: Options = {
    agent: p.role,
    agents,
    model: p.model,
    effort: p.effort,
    cwd: p.worktree,
    resume: p.resumeSessionId,
    permissionMode: "bypassPermissions",
    abortController,
    maxBudgetUsd,
    // canUseTool now only enforces file-path scope (out-of-zone Edit/Write).
    // Tool-name deny is native via agent.disallowedTools.
    canUseTool: buildCanUseTool(cfg.scope.denied),
    mcpServers: Object.fromEntries(
      Object.entries(p.mcpServers).map(([name, s]) => [
        name,
        { type: "stdio" as const, command: s.command, args: s.args, env: s.env },
      ]),
    ),
    hooks: cfg.checks.length > 0 ? {
      PostToolUse: [{
        hooks: [async (raw) => {
          const input = raw as PostToolUseHookInput;
          const filePath = (input.tool_input as { file_path?: string } | undefined)?.file_path;
          if (!filePath) return {};
          const tool = input.tool_name;
          if (tool !== "Edit" && tool !== "Write" && tool !== "MultiEdit") return {};

          // Enqueue the same observe-check job the CLI hook uses — keeps both
          // runtimes converging on one analyzer pipeline.
          await enqueue({
            kind: CHECK_KIND,
            payload: {
              projectId: p.projectId,
              sessionId: p.sessionId,
              taskId: p.taskId,
              role: p.role,
              worktree: p.worktree,
              filePath,
            },
          });
          return {};
        }],
      }],
    } : undefined,
  };

  appendLog(p.projectId, p.sessionId, p.role, "system",
    `SDK run started: model=${p.model} effort=${p.effort ?? "(default)"} worktree=${p.worktree} budget=$${maxBudgetUsd} timeout=${runTimeoutMs}ms`);

  const stream = query({ prompt: p.bootstrap, options });

  try {
    for await (const message of stream) {
      logMessage(p, message);
      if (message.type === "result") {
        await recordCost({
          projectId: p.projectId,
          sessionId: p.sessionId,
          taskId: p.taskId,
          role: p.role,
          result: message,
        }).catch((e) => logBackgroundError("sdk-runner:recordCost", e, p.projectId));

        if (message.subtype === "error_max_budget_usd") {
          outcome.capExceeded = {
            kind: "budget",
            detail: `Run exceeded per-run budget $${maxBudgetUsd}`,
          };
          appendLog(p.projectId, p.sessionId, p.role, "error",
            `SDK aborted: per-run budget $${maxBudgetUsd} exceeded`);
          await escalate(
            p.projectId, p.taskId,
            `Agent ${p.role} exceeded per-run budget $${maxBudgetUsd} on task ${p.taskId}`,
            { event: "budget_cap", role: p.role, sessionId: p.sessionId, budgetUsd: maxBudgetUsd },
          ).catch((e) => logBackgroundError("sdk-runner:budget-escalate", e, p.projectId));
        }
      }
    }
    await updateSession(p.sessionId, { status: "terminated", finishedAt: new Date() });
    appendLog(p.projectId, p.sessionId, p.role, "system", "SDK run completed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateSession(p.sessionId, { status: "crashed", finishedAt: new Date() });
    if (timedOut) {
      outcome.capExceeded = { kind: "timeout", detail: `Run exceeded ${runTimeoutMs}ms` };
      appendLog(p.projectId, p.sessionId, p.role, "error",
        `SDK run aborted by timeout after ${runTimeoutMs}ms: ${msg}`);
      await escalate(
        p.projectId, p.taskId,
        `Agent ${p.role} run exceeded ${runTimeoutMs}ms timeout on task ${p.taskId}`,
        { event: "run_timeout", role: p.role, sessionId: p.sessionId, timeoutMs: runTimeoutMs },
      ).catch((e) => logBackgroundError("sdk-runner:timeout-escalate", e, p.projectId));
    } else if (abortController.signal.aborted) {
      outcome.capExceeded = { kind: "aborted", detail: String(abortController.signal.reason ?? "aborted") };
      appendLog(p.projectId, p.sessionId, p.role, "error", `SDK run aborted: ${msg}`);
    } else {
      appendLog(p.projectId, p.sessionId, p.role, "error", `SDK run failed: ${msg}`);
      throw err; // let the scheduler handler decide retry
    }
  } finally {
    clearTimeout(timeoutHandle);
    unregisterSessionController(p.sessionId);
  }

  return outcome;
}

function logMessage(p: SdkRunInput, m: SDKMessage): void {
  switch (m.type) {
    case "assistant": {
      const text = extractText(m.message.content);
      if (text) appendLog(p.projectId, p.sessionId, p.role, "stdout", text);
      break;
    }
    case "user": {
      // user-role messages from the SDK are tool results piped back
      const text = extractText(m.message.content);
      if (text) appendLog(p.projectId, p.sessionId, p.role, "stdout", text);
      break;
    }
    case "result": {
      const cost = m.total_cost_usd != null ? ` cost=$${m.total_cost_usd.toFixed(4)}` : "";
      appendLog(p.projectId, p.sessionId, p.role, "system",
        `SDK result: subtype=${m.subtype}${cost} duration=${m.duration_ms}ms`);
      break;
    }
    case "system":
      // Init / mcp connection notices — verbose, drop unless debugging.
      break;
    default:
      // partial_assistant / tool_progress / task_notification — skip
      break;
  }
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block && "type" in block) {
      const b = block as { type: string; text?: string; name?: string; input?: unknown };
      if (b.type === "text" && b.text) parts.push(b.text);
      else if (b.type === "tool_use" && b.name) parts.push(`[tool:${b.name}]`);
    }
  }
  return parts.join("\n");
}

/**
 * File-path scope enforcement: reject Edit/Write/MultiEdit when the
 * target lands in a denied directory. Tool-name deny ("Edit",
 * "mcp__pencil__*") is handled natively by the SDK now via
 * `AgentDefinition.disallowedTools` — this hook only catches the
 * file-path layer because the SDK doesn't have a built-in equivalent.
 */
export function buildCanUseTool(deniedGlobs: string[]): CanUseTool | undefined {
  if (deniedGlobs.length === 0) return undefined;

  return async (toolName, input) => {
    if (toolName !== "Edit" && toolName !== "Write" && toolName !== "MultiEdit") {
      return { behavior: "allow", updatedInput: input };
    }
    const filePath = (input as { file_path?: string }).file_path;
    if (!filePath) return { behavior: "allow", updatedInput: input };

    for (const pattern of deniedGlobs) {
      if (minimatch(filePath, pattern) || minimatch(filePath, `**/${pattern}`)) {
        return {
          behavior: "deny",
          message: `Path ${filePath} is outside this role's scope (denied: ${pattern})`,
        };
      }
    }
    return { behavior: "allow", updatedInput: input };
  };
}
