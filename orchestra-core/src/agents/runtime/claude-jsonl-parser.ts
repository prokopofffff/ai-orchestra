import type { ModelUsage, RuntimeEvent, ToolUseEvent } from "./types";

/**
 * Raw shapes emitted by `claude -p --output-format=stream-json --verbose`.
 * Fields beyond what we consume are typed as `[k: string]: unknown` so
 * version bumps of the CLI don't tighten our parser.
 */
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean };

type InitMessage = {
  type: "system";
  subtype: "init";
  session_id: string;
  model: string;
  tools?: string[];
  mcp_servers?: { name: string; status: string }[];
};

type AssistantMessage = {
  type: "assistant";
  message: { content: ContentBlock[] };
  /** Set when the SDK/CLI surfaces an auth or transport failure mid-turn. */
  error?: string;
};

type UserMessage = {
  type: "user";
  message: { content: ContentBlock[] };
};

type ResultMessage = {
  type: "result";
  subtype: string;
  is_error: boolean;
  total_cost_usd: number;
  duration_ms: number;
  modelUsage?: Record<string, ModelUsage>;
  session_id: string;
  terminal_reason?: string;
  result?: string;
  /** Final tally of canUseTool denials. The CLI doesn't stream these inline. */
  permission_denials?: { tool_name: string; reason?: string }[];
};

export type ClaudeStreamMessage =
  | InitMessage
  | AssistantMessage
  | UserMessage
  | ResultMessage
  | { type: string; [k: string]: unknown };

/**
 * Convert one Claude stream-json message into zero or more RuntimeEvents.
 * Stays a pure function so it's easy to fixture-test.
 */
export function* normalizeClaudeMessage(
  raw: ClaudeStreamMessage,
): Iterable<RuntimeEvent> {
  switch (raw.type) {
    case "system": {
      const m = raw as InitMessage;
      if (m.subtype !== "init") return;
      yield {
        type: "init",
        sessionId: m.session_id,
        model: m.model,
        tools: m.tools ?? [],
        mcpServers: m.mcp_servers ?? [],
      };
      return;
    }
    case "assistant": {
      const m = raw as AssistantMessage;
      for (const block of m.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          yield { type: "assistant_text", text: block.text };
        } else if (block.type === "tool_use") {
          yield {
            type: "tool_use",
            tool: { toolName: block.name, input: block.input, toolUseId: block.id },
          };
        }
      }
      if (m.error) yield { type: "error", message: m.error };
      return;
    }
    case "user": {
      // tool_result echoed back to the conversation. The spawner logs these
      // as stdout for the agent_logs stream, but they're not load-bearing —
      // assistant turns already capture the model's perspective. Skip for
      // now; reintroduce a tool_result event if a consumer needs it.
      return;
    }
    case "result": {
      const m = raw as ResultMessage;
      for (const d of m.permission_denials ?? []) {
        yield {
          type: "permission_denied",
          toolName: d.tool_name ?? "unknown",
          reason: d.reason ?? "",
        };
      }
      yield {
        type: "result",
        result: {
          isError: m.is_error,
          subtype: m.subtype,
          totalCostUsd: m.total_cost_usd ?? 0,
          durationMs: m.duration_ms ?? 0,
          modelUsage: m.modelUsage ?? {},
          sessionId: m.session_id,
          finalText: m.result,
        },
      };
      return;
    }
    default:
      // partial_assistant / task_notification / tool_progress / etc — silent.
      return;
  }
}

/**
 * Line-buffered parser. Reads raw chunks (stdout from the child) and yields
 * one ClaudeStreamMessage per JSONL line. Tolerates split lines, leading
 * blanks, and unparseable noise — the CLI occasionally interleaves a stderr
 * stragglers when `--verbose` is on and a transport retry hits.
 */
export async function* parseClaudeStream(
  source: AsyncIterable<string | Buffer>,
): AsyncIterable<ClaudeStreamMessage> {
  let buf = "";
  for await (const chunk of source) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const parsed = tryParseJson(line);
      if (parsed) yield parsed;
    }
  }
  const tail = buf.trim();
  if (tail) {
    const parsed = tryParseJson(tail);
    if (parsed) yield parsed;
  }
}

function tryParseJson(line: string): ClaudeStreamMessage | null {
  try {
    return JSON.parse(line) as ClaudeStreamMessage;
  } catch {
    return null;
  }
}

/**
 * Compose normalize + parse: source → RuntimeEvent stream. The runtime
 * pumps this into the caller's onEvent callback in order.
 */
export async function* normalizeClaudeStream(
  source: AsyncIterable<string | Buffer>,
): AsyncIterable<RuntimeEvent> {
  for await (const msg of parseClaudeStream(source)) {
    yield* normalizeClaudeMessage(msg);
  }
}

/**
 * Format a tool_use event as a one-line log entry. Mirrors the
 * `[tool:Name] summary` shape the old sdk-runner.extractText produced —
 * keeps the agent_logs stream visually unchanged across the refactor.
 */
export function formatToolUseLine(t: ToolUseEvent): string {
  const summary = summarizeToolInput(t.toolName, t.input);
  return summary ? `[tool:${t.toolName}] ${summary}` : `[tool:${t.toolName}]`;
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const v = input as Record<string, unknown>;
  const trim = (s: unknown, max = 160): string => {
    const str = typeof s === "string" ? s : JSON.stringify(s);
    if (!str) return "";
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
  };

  if (name === "Bash") return trim(v.command);
  if (name === "Read") return trim(v.file_path ?? v.filePath, 200);
  if (name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") {
    return trim(v.file_path ?? v.filePath, 200);
  }
  if (name === "Glob" || name === "Grep") return trim(v.pattern ?? v.query);
  if (name === "Task" || name === "Agent") {
    const subtype = v.subagent_type ?? v.subagentType;
    const desc = v.description;
    return [subtype, desc].filter(Boolean).map((s) => trim(s, 120)).join(" — ");
  }
  if (name === "WebFetch") return trim(v.url, 200);
  return trim(v, 160);
}
