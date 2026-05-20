import type { ModelUsage, RuntimeEvent, ToolUseEvent } from "./types";

/**
 * Raw event shapes emitted by `codex exec --json`. Documented at
 * https://developers.openai.com/codex/noninteractive — current as of
 * Codex CLI 0.131.0 (May 2026).
 *
 * Three quirks shape the normalizer:
 *   1. `thread.started` is the session-id event. There's no separate init
 *      that lists tools/mcp like Claude's; we synthesize init with the
 *      model the runtime knows it spawned with.
 *   2. Token usage lands on `turn.completed`; USD cost is NOT in the stream.
 *      We compute it from tokens × a per-model rate table below.
 *   3. `item.completed` for type=command_execution / type=mcp_call carries
 *      tool invocations. type=text is the assistant message.
 */
type ThreadStarted = { type: "thread.started"; thread_id: string };
type TurnStarted = { type: "turn.started" };
type TurnCompleted = {
  type: "turn.completed";
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
};
type TurnFailed = {
  type: "turn.failed";
  error?: { message?: string };
};
type ErrorEvent = { type: "error"; message?: string };

type CodexItem =
  | { type: "text"; text?: string }
  | { type: "command_execution"; command?: string; output?: string; exit_code?: number }
  | { type: "mcp_call"; server?: string; tool?: string; arguments?: unknown }
  | { type: string; [k: string]: unknown };

type ItemEvent = {
  type: "item.started" | "item.completed";
  item?: CodexItem;
  /** Some versions wrap fields under `item`; others flatten to top-level. */
  text?: string;
  command?: string;
};

export type CodexStreamMessage =
  | ThreadStarted
  | TurnStarted
  | TurnCompleted
  | TurnFailed
  | ErrorEvent
  | ItemEvent
  | { type: string; [k: string]: unknown };

/**
 * Per-model pricing for cost computation. Codex doesn't emit USD itself so we
 * derive it from tokens × these rates. ⚠ verify against the OpenAI pricing
 * page (https://openai.com/api/pricing/) on every minor — model names and
 * prices change quarterly. When a model is missing here we fall back to
 * gpt-5-codex rates and log a warning; the run still completes, the cost
 * row just carries an approximation.
 *
 * Units: USD per 1M tokens. cachedInputPerM applies to cached_input_tokens;
 * reasoning_output_tokens are billed at outputPerM (same as visible output).
 */
const CODEX_RATES: Record<string, {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM?: number;
}> = {
  "gpt-5-codex": { inputPerM: 1.25, outputPerM: 10.0, cachedInputPerM: 0.125 },
  "gpt-5.2": { inputPerM: 1.25, outputPerM: 10.0, cachedInputPerM: 0.125 },
  "gpt-5.2-codex": { inputPerM: 1.25, outputPerM: 10.0, cachedInputPerM: 0.125 },
  "gpt-5.5": { inputPerM: 1.5, outputPerM: 12.0, cachedInputPerM: 0.15 },
};
const FALLBACK_RATE = CODEX_RATES["gpt-5-codex"];

/**
 * Compute USD spend from a Codex `turn.completed.usage` block + the model
 * name the runtime spawned with. Exported for tests and the cost-tracker.
 */
export function computeCodexCostUsd(
  model: string,
  usage: TurnCompleted["usage"],
): { costUsd: number; modelUsage: ModelUsage } {
  const rate = CODEX_RATES[model] ?? FALLBACK_RATE;
  const input = usage?.input_tokens ?? 0;
  const cached = usage?.cached_input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const reasoning = usage?.reasoning_output_tokens ?? 0;
  const totalOutput = output + reasoning;

  const billableInput = Math.max(0, input - cached);
  const inputCost = (billableInput / 1_000_000) * rate.inputPerM;
  const cachedCost = (cached / 1_000_000) * (rate.cachedInputPerM ?? rate.inputPerM);
  const outputCost = (totalOutput / 1_000_000) * rate.outputPerM;
  const costUsd = inputCost + cachedCost + outputCost;

  return {
    costUsd,
    modelUsage: {
      costUSD: costUsd,
      inputTokens: input,
      outputTokens: totalOutput,
      cacheReadInputTokens: cached,
      cacheCreationInputTokens: 0, // Codex doesn't distinguish creation vs read
    },
  };
}

/**
 * Stateful streaming normalizer: a single Codex run threads state across
 * multiple raw events (we need the thread_id from thread.started before we
 * can fully populate the result event's sessionId). Use as:
 *
 *     const norm = createCodexNormalizer({ model });
 *     for await (const raw of parseCodexStream(stdout)) {
 *       for (const evt of norm.consume(raw)) yield evt;
 *     }
 */
export function createCodexNormalizer(ctx: { model: string }) {
  let sessionId = "";
  let lastAssistantText = "";
  let firstTurn = true;

  return {
    consume(raw: CodexStreamMessage): RuntimeEvent[] {
      const out: RuntimeEvent[] = [];

      switch (raw.type) {
        case "thread.started": {
          sessionId = (raw as ThreadStarted).thread_id;
          out.push({
            type: "init",
            sessionId,
            model: ctx.model,
            // Codex doesn't surface its tool list or MCP wiring in-stream.
            // The runtime knows them but the spawner observer doesn't need
            // them for cost/logging — leave empty.
            tools: [],
            mcpServers: [],
          });
          return out;
        }

        case "turn.started":
          firstTurn = false;
          void firstTurn; // reserved for "first-turn" diagnostics if useful later
          return out;

        case "item.completed":
        case "item.started": {
          const ev = raw as ItemEvent;
          const item = ev.item ?? { type: "" };
          // Only emit on .completed — .started fires before content is final
          // and would duplicate the same event when .completed lands.
          if (raw.type !== "item.completed") return out;

          if (item.type === "text") {
            const text = (item as { text?: string }).text ?? ev.text ?? "";
            if (text) {
              lastAssistantText = text;
              out.push({ type: "assistant_text", text });
            }
          } else if (item.type === "command_execution") {
            const command = (item as { command?: string }).command ?? ev.command ?? "";
            const tool: ToolUseEvent = {
              toolName: "Bash",
              input: { command },
              // Codex doesn't give us a stable tool_use_id; synthesize one
              // so consumers that key by id (e.g. tool_result pairing) don't
              // collide across multiple commands in one turn.
              toolUseId: `codex-cmd-${Math.random().toString(36).slice(2, 10)}`,
            };
            out.push({ type: "tool_use", tool });
          } else if (item.type === "mcp_call") {
            const m = item as { server?: string; tool?: string; arguments?: unknown };
            const tool: ToolUseEvent = {
              toolName: `mcp__${m.server ?? "unknown"}__${m.tool ?? "unknown"}`,
              input: m.arguments,
              toolUseId: `codex-mcp-${Math.random().toString(36).slice(2, 10)}`,
            };
            out.push({ type: "tool_use", tool });
          }
          // Other item types (web_search, file_change, …) silently dropped
          // for now — we don't surface them anywhere yet.
          return out;
        }

        case "turn.completed": {
          const usage = (raw as TurnCompleted).usage;
          const { costUsd, modelUsage } = computeCodexCostUsd(ctx.model, usage);
          out.push({
            type: "result",
            result: {
              isError: false,
              subtype: "success",
              totalCostUsd: costUsd,
              durationMs: 0, // codex doesn't report it; computed by runtime if needed
              modelUsage: { [ctx.model]: modelUsage },
              sessionId,
              finalText: lastAssistantText || undefined,
            },
          });
          return out;
        }

        case "turn.failed": {
          const msg = (raw as TurnFailed).error?.message ?? "turn failed";
          out.push({ type: "error", message: msg });
          // Synthesize a terminal result so observers (cost-tracker, freeze)
          // see a single end-of-run event regardless of provider.
          const { costUsd, modelUsage } = computeCodexCostUsd(ctx.model, undefined);
          out.push({
            type: "result",
            result: {
              isError: true,
              subtype: "error",
              totalCostUsd: costUsd,
              durationMs: 0,
              modelUsage: { [ctx.model]: modelUsage },
              sessionId,
            },
          });
          return out;
        }

        case "error": {
          const msg = (raw as ErrorEvent).message ?? "stream error";
          out.push({ type: "error", message: msg });
          return out;
        }

        default:
          return out;
      }
    },
  };
}

/**
 * Same line-buffered parser shape as the Claude one. Codex emits one JSON
 * per line on stdout when invoked with `--json`. Stderr carries diagnostics
 * — caller discards it.
 */
export async function* parseCodexStream(
  source: AsyncIterable<string | Buffer>,
): AsyncIterable<CodexStreamMessage> {
  let buf = "";
  for await (const chunk of source) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as CodexStreamMessage;
      } catch {
        /* skip non-JSON noise (codex interleaves ERROR diagnostics on retries) */
      }
    }
  }
  const tail = buf.trim();
  if (tail) {
    try { yield JSON.parse(tail) as CodexStreamMessage; } catch { /* swallow */ }
  }
}
