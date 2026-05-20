import type { AgentRole } from "../../config";

/**
 * Normalized per-model usage. Mirrors the SDK's `ModelUsage` shape so we can
 * keep cost-tracker's per-model row layout. The Claude CLI emits the same
 * field names in `result.modelUsage`; a Codex runtime computes costUSD from
 * tokens × rates and fills these.
 */
export type ModelUsage = {
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

/**
 * Normalized agent run result. Carries everything cost-tracker and the
 * spawner need to record / freeze a task. Runtime-agnostic — Claude CLI and
 * Codex CLI both flatten into this.
 */
export type RuntimeResult = {
  /** True when the run ended in an error path (auth fail, budget cap, etc). */
  isError: boolean;
  /**
   * Termination cause. Subset matters to cost-tracker freeze logic:
   *   - "success" — normal end
   *   - "error_max_budget_usd" — per-run budget cap tripped
   *   - "error_max_turns" — agent loop cap tripped
   *   - "error" — generic failure
   */
  subtype: string;
  totalCostUsd: number;
  durationMs: number;
  /** Per-model usage. Empty for runs that ended before any API call landed. */
  modelUsage: Record<string, ModelUsage>;
  sessionId: string;
  /** Final assistant message text, when one was produced. */
  finalText?: string;
};

/**
 * Tool-call event. Surfaced so observers can drive PostToolUse-style logic
 * (observe-check enqueue on Edit/Write) without an in-runtime hook callback.
 */
export type ToolUseEvent = {
  toolName: string;
  input: unknown;
  toolUseId: string;
};

/**
 * Stream event union. Designed so both the spawner (logs + cost) and the
 * tech-lead dispatcher (real-time chat notifications + code-block guard +
 * deny-streak abort) can consume the same shape. Codex's JSONL gets flattened
 * into these too, so a single observer pipeline serves both providers.
 */
export type RuntimeEvent =
  | {
      type: "init";
      sessionId: string;
      model: string;
      tools: string[];
      mcpServers: { name: string; status: string }[];
    }
  /**
   * Assistant text chunk. May be a complete turn or a single content block
   * within a turn. Concatenated chunks form the visible reply.
   */
  | { type: "assistant_text"; text: string }
  /** Model decided to call a tool. Carried before tool_result. */
  | { type: "tool_use"; tool: ToolUseEvent }
  /**
   * canUseTool / permissions denied a tool call. TL dispatcher uses these
   * to count a deny-streak and abort the run if it crosses a threshold.
   */
  | { type: "permission_denied"; toolName: string; reason: string }
  /** Terminal event of a run — exactly one per run. */
  | { type: "result"; result: RuntimeResult }
  /**
   * Stream-level error event. Not a final-state — the runtime may still
   * emit a `result` after. Treat as a log line, not a terminal signal.
   */
  | { type: "error"; message: string };

/**
 * Per-run input. Pulled together by the caller (spawner or TL dispatcher)
 * from project + role config + session row. Stays runtime-agnostic.
 */
export type AgentRunInput = {
  projectId: string;
  /** Null for tech-lead chat (no task linkage). */
  taskId: string | null;
  sessionId: string;
  role: AgentRole;
  /** Provider-native model id. Claude: "opus" / "sonnet" / full slug. */
  model: string;
  /** Effort hint. Undefined → runtime picks its default. */
  effort?: "low" | "medium" | "high" | "max";
  /** Working directory the agent runs in (worktree path or TL's workDir). */
  cwd: string;
  /**
   * Dynamic per-run user turn. Static role identity / scope / rules live on
   * the agent definition (role-definitions.ts) and are passed by the runtime.
   */
  prompt: string;
  pencilEnabled?: boolean;
  /** MCP server config in our normalized shape. Runtime translates per provider. */
  mcpServers: Record<
    string,
    { command: string; args: string[]; env?: Record<string, string> }
  >;
  /** Project settings JSONB (for budget/timeout resolution). */
  settings?: unknown;
  /** Resume a prior session by id. Provider-specific semantics. */
  resumeSessionId?: string;
  /**
   * Caller-owned abort signal. Spawner registers it with session-manager so
   * an admin "stop session" call reaches the in-flight run. TL dispatcher
   * stores the controller in its per-project map to support interruptTechLead.
   */
  abortSignal: AbortSignal;
  /**
   * Per-spawn env vars. Merged on top of process.env when spawning the child.
   * `undefined` deletes the key (used to strip ANTHROPIC_API_KEY in
   * subscription mode so the previous run's key can't leak into this one).
   *
   * Populated by the auth resolver (claude-auth / codex-auth) with CLAUDE_CONFIG_DIR,
   * CODEX_HOME, ANTHROPIC_API_KEY, etc — whatever the selected provider+mode
   * needs to authenticate.
   */
  spawnEnv?: Record<string, string | undefined>;
};

/** Returned to the caller. Same shape as the old SdkRunOutcome. */
export type AgentRunOutcome = {
  /** Set when the run aborted on a cap; downstream may freeze the task. */
  capExceeded?: { kind: "budget" | "timeout" | "aborted"; detail: string };
};

/**
 * The runtime drives the agent end-to-end: spawns the child, normalizes its
 * output stream into RuntimeEvents, delivers them to the observer, enforces
 * the per-run budget + timeout, and returns the outcome on completion. One
 * implementation per provider — currently Claude CLI; Codex CLI follows.
 */
export interface AgentRuntime {
  run(
    input: AgentRunInput,
    onEvent: (e: RuntimeEvent) => void | Promise<void>,
  ): Promise<AgentRunOutcome>;
}
