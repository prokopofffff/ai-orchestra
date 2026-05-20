import type { AgentRole } from "../../config";
import { appendLog } from "../../logger";
import { recordCost } from "../../cost-tracker";
import { enqueue } from "../../scheduler";
import { logBackgroundError } from "../../error-handler";
import { escalate } from "../../notification-hub";
import { CHECK_KIND } from "../check-handlers";
import { agentConfigs } from "../configs";
import { formatToolUseLine } from "./claude-jsonl-parser";
import type { RuntimeEvent } from "./types";

/**
 * Shared context for the per-event observers below. Pulled together once
 * by the caller (agent-spawner / tech-lead-dispatcher) and threaded
 * through each event.
 */
export type ObserverContext = {
  projectId: string;
  sessionId: string;
  /** Null for tech-lead chat — no associated task. */
  taskId: string | null;
  role: AgentRole;
  /** Worktree path; needed by observe-check to scope where to run the linter. */
  worktree: string;
};

/**
 * Append a RuntimeEvent to the agent_logs stream in the human-readable
 * shape the dashboard's log viewer expects. Preserves the assistant +
 * `[tool:Name]` interleaving the old sdk-runner.logMessage produced, so
 * the operator's view doesn't shift across the CLI migration.
 */
export function logRuntimeEvent(ctx: ObserverContext, evt: RuntimeEvent): void {
  switch (evt.type) {
    case "init": {
      const orchestraTools = evt.tools.filter((t) => t.startsWith("mcp__orchestra"));
      appendLog(
        ctx.projectId, ctx.sessionId, ctx.role, "system",
        `MCP init: servers=${JSON.stringify(evt.mcpServers)}  orchestra_tools=${JSON.stringify(orchestraTools)}`,
      );
      return;
    }
    case "assistant_text":
      appendLog(ctx.projectId, ctx.sessionId, ctx.role, "stdout", evt.text);
      return;
    case "tool_use":
      appendLog(ctx.projectId, ctx.sessionId, ctx.role, "stdout", formatToolUseLine(evt.tool));
      return;
    case "permission_denied":
      appendLog(
        ctx.projectId, ctx.sessionId, ctx.role, "error",
        `permission denied: ${evt.toolName}${evt.reason ? ` (${evt.reason})` : ""}`,
      );
      return;
    case "result": {
      const cost = evt.result.totalCostUsd != null
        ? ` cost=$${evt.result.totalCostUsd.toFixed(4)}` : "";
      appendLog(
        ctx.projectId, ctx.sessionId, ctx.role, "system",
        `result: subtype=${evt.result.subtype}${cost} duration=${evt.result.durationMs}ms`,
      );
      return;
    }
    case "error":
      appendLog(ctx.projectId, ctx.sessionId, ctx.role, "error", evt.message);
      return;
  }
}

/**
 * Enqueue an observe-check job for every Edit/Write/MultiEdit. Replaces the
 * old sdk-runner PostToolUse hook closure — same payload, same downstream
 * pipeline, just sourced from the runtime's event stream instead of an
 * in-process SDK callback. No-op when the role's `checks` array is empty.
 */
export async function enqueueObserveCheck(
  ctx: ObserverContext,
  evt: RuntimeEvent,
): Promise<void> {
  if (evt.type !== "tool_use") return;
  const tool = evt.tool.toolName;
  if (tool !== "Edit" && tool !== "Write" && tool !== "MultiEdit") return;
  const cfg = agentConfigs[ctx.role];
  if (cfg.checks.length === 0) return;
  const filePath = (evt.tool.input as { file_path?: string } | undefined)?.file_path;
  if (!filePath) return;

  await enqueue({
    kind: CHECK_KIND,
    payload: {
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      taskId: ctx.taskId,
      role: ctx.role,
      worktree: ctx.worktree,
      filePath,
    },
  });
}

/**
 * Persist per-model spend + escalate on budget cap. Wraps cost-tracker's
 * recordCost so each caller doesn't need to reach into the result event
 * shape. Best-effort: a failing cost insert never fails the run, but it
 * does get logged — losing cost data breaks the daily-cap accounting.
 */
export async function recordRuntimeCost(
  ctx: ObserverContext,
  evt: RuntimeEvent,
  opts: { maxBudgetUsd?: number } = {},
): Promise<void> {
  if (evt.type !== "result") return;
  await recordCost({
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    role: ctx.role,
    result: evt.result,
  }).catch((e) => logBackgroundError("runtime:recordCost", e, ctx.projectId));

  if (evt.result.subtype === "error_max_budget_usd" && opts.maxBudgetUsd != null) {
    await escalate(
      ctx.projectId, ctx.taskId,
      `Агент ${ctx.role} превысил бюджет $${opts.maxBudgetUsd} на задаче ${ctx.taskId ?? "(без задачи)"}`,
      { event: "budget_cap", role: ctx.role, sessionId: ctx.sessionId, budgetUsd: opts.maxBudgetUsd },
    ).catch((e) => logBackgroundError("runtime:budget-escalate", e, ctx.projectId));
  }
}
