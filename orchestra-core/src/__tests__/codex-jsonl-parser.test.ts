import { describe, it, expect } from "vitest";
import {
  createCodexNormalizer,
  parseCodexStream,
  computeCodexCostUsd,
  type CodexStreamMessage,
} from "../agents/runtime/codex-jsonl-parser";
import type { RuntimeEvent } from "../agents/runtime/types";

describe("createCodexNormalizer", () => {
  it("emits an init event from thread.started, using the runtime's model arg", () => {
    const norm = createCodexNormalizer({ model: "gpt-5-codex" });
    const events = norm.consume({ type: "thread.started", thread_id: "thr-1" } as CodexStreamMessage);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "init",
      sessionId: "thr-1",
      model: "gpt-5-codex",
    });
  });

  it("emits assistant_text from item.completed with type=text", () => {
    const norm = createCodexNormalizer({ model: "gpt-5-codex" });
    norm.consume({ type: "thread.started", thread_id: "x" } as CodexStreamMessage);
    const events = norm.consume({
      type: "item.completed",
      item: { type: "text", text: "hello" },
    } as CodexStreamMessage);
    expect(events).toEqual([{ type: "assistant_text", text: "hello" }]);
  });

  it("emits a Bash tool_use from item.completed with type=command_execution", () => {
    const norm = createCodexNormalizer({ model: "gpt-5-codex" });
    norm.consume({ type: "thread.started", thread_id: "x" } as CodexStreamMessage);
    const events = norm.consume({
      type: "item.completed",
      item: { type: "command_execution", command: "ls -la" },
    } as CodexStreamMessage);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_use",
      tool: { toolName: "Bash", input: { command: "ls -la" } },
    });
  });

  it("emits an mcp__ tool_use from item.completed with type=mcp_call", () => {
    const norm = createCodexNormalizer({ model: "gpt-5-codex" });
    norm.consume({ type: "thread.started", thread_id: "x" } as CodexStreamMessage);
    const events = norm.consume({
      type: "item.completed",
      item: { type: "mcp_call", server: "orchestra-signal-tool", tool: "signal_agent", arguments: { foo: 1 } },
    } as CodexStreamMessage);
    expect(events[0]).toMatchObject({
      type: "tool_use",
      tool: { toolName: "mcp__orchestra-signal-tool__signal_agent", input: { foo: 1 } },
    });
  });

  it("ignores item.started — we only emit on .completed to avoid duplicates", () => {
    const norm = createCodexNormalizer({ model: "gpt-5-codex" });
    norm.consume({ type: "thread.started", thread_id: "x" } as CodexStreamMessage);
    const events = norm.consume({
      type: "item.started",
      item: { type: "text", text: "partial" },
    } as CodexStreamMessage);
    expect(events).toEqual([]);
  });

  it("emits a result event with computed cost from turn.completed.usage", () => {
    const norm = createCodexNormalizer({ model: "gpt-5-codex" });
    norm.consume({ type: "thread.started", thread_id: "thr-1" } as CodexStreamMessage);
    const events = norm.consume({
      type: "turn.completed",
      usage: { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 0, reasoning_output_tokens: 0 },
    } as CodexStreamMessage);
    expect(events).toHaveLength(1);
    const result = events[0] as Extract<RuntimeEvent, { type: "result" }>;
    expect(result.result.subtype).toBe("success");
    expect(result.result.sessionId).toBe("thr-1");
    expect(result.result.totalCostUsd).toBeGreaterThan(0);
    expect(result.result.modelUsage["gpt-5-codex"].inputTokens).toBe(1000);
    expect(result.result.modelUsage["gpt-5-codex"].outputTokens).toBe(200);
  });

  it("on turn.failed emits an error event AND a synthetic result so observers see one terminal event", () => {
    const norm = createCodexNormalizer({ model: "gpt-5-codex" });
    norm.consume({ type: "thread.started", thread_id: "x" } as CodexStreamMessage);
    const events = norm.consume({
      type: "turn.failed",
      error: { message: "auth failed" },
    } as CodexStreamMessage);
    expect(events.map((e) => e.type)).toEqual(["error", "result"]);
    const result = events[1] as Extract<RuntimeEvent, { type: "result" }>;
    expect(result.result.isError).toBe(true);
    expect(result.result.subtype).toBe("error");
  });
});

describe("computeCodexCostUsd", () => {
  it("computes cost = (input × inputRate + cached × cachedRate + (output + reasoning) × outputRate) / 1M", () => {
    const { costUsd, modelUsage } = computeCodexCostUsd("gpt-5-codex", {
      input_tokens: 100_000, // billable: 100k - 50k cached = 50k
      cached_input_tokens: 50_000,
      output_tokens: 10_000,
      reasoning_output_tokens: 2_000,
    });
    // 50k input × 1.25/M = $0.0625; 50k cached × 0.125/M = $0.00625; 12k output × 10/M = $0.12
    expect(costUsd).toBeCloseTo(0.0625 + 0.00625 + 0.12, 6);
    // modelUsage reports raw input (100k), combined output (12k), cached separately
    expect(modelUsage.inputTokens).toBe(100_000);
    expect(modelUsage.outputTokens).toBe(12_000);
    expect(modelUsage.cacheReadInputTokens).toBe(50_000);
  });

  it("falls back to gpt-5-codex rates for an unknown model", () => {
    const known = computeCodexCostUsd("gpt-5-codex", { input_tokens: 1_000_000, output_tokens: 0 });
    const unknown = computeCodexCostUsd("gpt-9000-superhuman", { input_tokens: 1_000_000, output_tokens: 0 });
    expect(unknown.costUsd).toBeCloseTo(known.costUsd, 6);
  });

  it("handles zero/missing usage without exploding", () => {
    expect(computeCodexCostUsd("gpt-5-codex", undefined).costUsd).toBe(0);
    expect(computeCodexCostUsd("gpt-5-codex", {}).costUsd).toBe(0);
  });
});

async function* fromStrings(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

describe("parseCodexStream", () => {
  it("handles split lines and ignores garbage interleaved between valid JSONL", async () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "x" }),
      "ERROR codex_api::endpoint::responses_websocket: failed to connect",
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
    ].join("\n") + "\n";
    const out: CodexStreamMessage[] = [];
    for await (const msg of parseCodexStream(fromStrings([lines]))) out.push(msg);
    expect(out.map((m) => m.type)).toEqual(["thread.started", "turn.started", "turn.completed"]);
  });
});
