import {
  query,
  type Options,
  type SDKMessage,
  type CanUseTool,
  type PostToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { minimatch } from "minimatch";
import { appendLog } from "../logger";
import { updateSession } from "../session-manager";
import { enqueue } from "../scheduler";
import { CHECK_KIND } from "./check-handlers";
import { getAgentConfig } from "./configs";
import type { AgentRole } from "../config";

export type SdkRunInput = {
  projectId: string;
  taskId: string;
  sessionId: string;
  role: AgentRole;
  model: string;
  worktree: string;
  fullPrompt: string;
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  resumeSessionId?: string;
};

/**
 * Execute an agent run via the Claude Agent SDK.
 *
 * Awaits the full run; the caller (rate-limiter handler) holds the scheduler
 * lease for the duration. On crash mid-run, the lease expires and the job
 * re-claims — at which point `resumeSessionId` lets us pick up where we left off.
 */
export async function runAgentSdk(p: SdkRunInput): Promise<void> {
  const cfg = getAgentConfig(p.role);

  const options: Options = {
    model: p.model,
    cwd: p.worktree,
    resume: p.resumeSessionId,
    permissionMode: "bypassPermissions",
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
    `SDK run started: model=${p.model} worktree=${p.worktree}`);

  const stream = query({ prompt: p.fullPrompt, options });

  try {
    for await (const message of stream) {
      logMessage(p, message);
    }
    await updateSession(p.sessionId, { status: "terminated", finishedAt: new Date() });
    appendLog(p.projectId, p.sessionId, p.role, "system", "SDK run completed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateSession(p.sessionId, { status: "crashed", finishedAt: new Date() });
    appendLog(p.projectId, p.sessionId, p.role, "error", `SDK run failed: ${msg}`);
    throw err; // let the scheduler handler decide retry
  }
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
 * Translate the role's denied globs into a tool-call gate. Edit/Write/MultiEdit
 * targeting a denied path is rejected before it runs.
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
