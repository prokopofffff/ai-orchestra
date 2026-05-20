import { describe, it, expect } from "vitest";
import {
  normalizeClaudeMessage,
  parseClaudeStream,
  normalizeClaudeStream,
  formatToolUseLine,
  type ClaudeStreamMessage,
} from "../agents/runtime/claude-jsonl-parser";
import type { RuntimeEvent } from "../agents/runtime/types";

/**
 * Fixtures lifted verbatim from a real `claude -p --output-format=stream-json
 * --verbose` run (CLI 2.1.144). Catches schema drift if the CLI ever renames a
 * field — would have caught the case where the SDK used `total_cost_usd` and
 * the CLI used `totalCost` (it doesn't, but the test is the proof).
 */
const INIT_MSG = {
  type: "system",
  subtype: "init",
  cwd: "/private/tmp/x",
  session_id: "0d7e527c-9774-4ed1-8b32-9ab721a4c40e",
  tools: ["Bash", "Edit", "Read", "mcp__orchestra-signal-tool__signal_agent"],
  mcp_servers: [{ name: "orchestra-signal-tool", status: "connected" }],
  model: "claude-opus-4-7[1m]",
  permissionMode: "default",
} as ClaudeStreamMessage;

const ASSISTANT_MSG = {
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "I'll start with a read." },
      { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/src/x.ts" } },
    ],
  },
  session_id: "sess",
} as ClaudeStreamMessage;

const RESULT_MSG = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 42,
  duration_api_ms: 30,
  num_turns: 2,
  result: "done.",
  stop_reason: "end_turn",
  session_id: "sess",
  total_cost_usd: 0.0421,
  usage: {},
  modelUsage: {
    "claude-opus-4-7": {
      costUSD: 0.0421,
      inputTokens: 1500,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  },
  permission_denials: [{ tool_name: "Bash", reason: "policy" }],
  terminal_reason: "completed",
} as ClaudeStreamMessage;

describe("normalizeClaudeMessage", () => {
  it("turns the init message into an init RuntimeEvent", () => {
    const events = [...normalizeClaudeMessage(INIT_MSG)];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "init",
      sessionId: "0d7e527c-9774-4ed1-8b32-9ab721a4c40e",
      model: "claude-opus-4-7[1m]",
      mcpServers: [{ name: "orchestra-signal-tool", status: "connected" }],
    });
  });

  it("splits an assistant turn into text + tool_use events in order", () => {
    const events = [...normalizeClaudeMessage(ASSISTANT_MSG)];
    expect(events.map((e) => e.type)).toEqual(["assistant_text", "tool_use"]);
    expect(events[0]).toMatchObject({ type: "assistant_text", text: "I'll start with a read." });
    expect(events[1]).toMatchObject({
      type: "tool_use",
      tool: { toolName: "Read", toolUseId: "toolu_01" },
    });
  });

  it("emits permission_denied events before the result event so observers see them in order", () => {
    const events = [...normalizeClaudeMessage(RESULT_MSG)];
    expect(events.map((e) => e.type)).toEqual(["permission_denied", "result"]);
    expect(events[0]).toMatchObject({ type: "permission_denied", toolName: "Bash", reason: "policy" });
    const result = events[1] as Extract<RuntimeEvent, { type: "result" }>;
    expect(result.result.totalCostUsd).toBeCloseTo(0.0421, 5);
    expect(result.result.modelUsage["claude-opus-4-7"].inputTokens).toBe(1500);
    expect(result.result.subtype).toBe("success");
  });

  it("skips unknown message types silently", () => {
    const events = [...normalizeClaudeMessage({ type: "partial_assistant", foo: 1 } as ClaudeStreamMessage)];
    expect(events).toEqual([]);
  });

  it("emits an error event when an assistant message carries an error field", () => {
    const msg = { ...ASSISTANT_MSG, error: "authentication_failed" } as ClaudeStreamMessage;
    const events = [...normalizeClaudeMessage(msg)];
    expect(events.at(-1)).toMatchObject({ type: "error", message: "authentication_failed" });
  });
});

async function* fromStrings(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

describe("parseClaudeStream", () => {
  it("handles split lines across chunks", async () => {
    const text = JSON.stringify(INIT_MSG) + "\n" + JSON.stringify(RESULT_MSG) + "\n";
    const halfway = Math.floor(text.length / 2);
    const out: ClaudeStreamMessage[] = [];
    for await (const msg of parseClaudeStream(fromStrings([text.slice(0, halfway), text.slice(halfway)]))) {
      out.push(msg);
    }
    expect(out.map((m) => m.type)).toEqual(["system", "result"]);
  });

  it("skips unparseable lines without losing valid ones around them", async () => {
    const text =
      JSON.stringify(INIT_MSG) + "\n" +
      "not-json-noise\n" +
      JSON.stringify(ASSISTANT_MSG) + "\n";
    const out: ClaudeStreamMessage[] = [];
    for await (const msg of parseClaudeStream(fromStrings([text]))) out.push(msg);
    expect(out.map((m) => m.type)).toEqual(["system", "assistant"]);
  });

  it("flushes a trailing partial line at end of stream", async () => {
    const text = JSON.stringify(INIT_MSG); // no trailing newline
    const out: ClaudeStreamMessage[] = [];
    for await (const msg of parseClaudeStream(fromStrings([text]))) out.push(msg);
    expect(out).toHaveLength(1);
  });
});

describe("normalizeClaudeStream (compose)", () => {
  it("walks an end-to-end run: init → assistant → result", async () => {
    const text =
      JSON.stringify(INIT_MSG) + "\n" +
      JSON.stringify(ASSISTANT_MSG) + "\n" +
      JSON.stringify(RESULT_MSG) + "\n";
    const events: RuntimeEvent[] = [];
    for await (const evt of normalizeClaudeStream(fromStrings([text]))) events.push(evt);
    expect(events.map((e) => e.type)).toEqual([
      "init", "assistant_text", "tool_use", "permission_denied", "result",
    ]);
  });
});

describe("formatToolUseLine", () => {
  it("renders Bash with the command", () => {
    expect(formatToolUseLine({ toolName: "Bash", input: { command: "git status -s" }, toolUseId: "t1" }))
      .toBe("[tool:Bash] git status -s");
  });
  it("renders Read with the file_path", () => {
    expect(formatToolUseLine({ toolName: "Read", input: { file_path: "src/x.ts" }, toolUseId: "t1" }))
      .toBe("[tool:Read] src/x.ts");
  });
  it("renders Edit with the file_path", () => {
    expect(formatToolUseLine({ toolName: "Edit", input: { file_path: "src/y.ts" }, toolUseId: "t1" }))
      .toBe("[tool:Edit] src/y.ts");
  });
  it("renders Task/Agent with subagent + description", () => {
    expect(formatToolUseLine({
      toolName: "Agent",
      input: { subagent_type: "Explore", description: "look for the build script" },
      toolUseId: "t1",
    })).toBe("[tool:Agent] Explore — look for the build script");
  });
  it("falls back to stringified input for unknown tools", () => {
    // {} stringifies to "{}" — short enough to show as-is. Matches the
    // sdk-runner.extractText behavior we're preserving.
    expect(formatToolUseLine({ toolName: "X", input: {}, toolUseId: "t1" })).toBe("[tool:X] {}");
  });
  it("renders bare [tool:Name] when input isn't an object at all", () => {
    expect(formatToolUseLine({ toolName: "X", input: null, toolUseId: "t1" })).toBe("[tool:X]");
  });
});
