import type { AgentRole } from "../config";

/**
 * Per-role agent configuration. Drives both prompt assembly and
 * `.claude/settings.json` generation (permissions + hooks).
 */
export type AgentConfig = {
  role: AgentRole;
  /** Prompt file basename under `prompts/` (without .md). */
  promptFile: string;
  /** Optional override when an external dep is missing (e.g. designer w/o pencil). */
  fallbackPromptFile?: string;
  /** File globs the agent may modify. Empty = no restriction. */
  scope: { allowed: string[]; denied: string[] };
  /**
   * settings.json permissions matchers. Tool names like "Read", "Edit",
   * "Bash(npm:*)", "Write". Empty arrays = inherit defaults.
   */
  permissions: { allow: string[]; deny: string[] };
  /**
   * Observe-only check spec. Each entry runs against files matching `pattern`
   * after Edit/Write tool use. `command` is executed in the worktree and its
   * exit code determines pass/fail (logged, not blocking).
   */
  checks: AgentCheck[];
};

export type AgentCheck = {
  name: string;
  /** Glob pattern matched against the changed file path. */
  pattern: string;
  /** Shell command to run in the worktree. Stdout/stderr captured for logs. */
  command: string;
  /** Severity if the check fails: "warn" → log only; "alert" → also signal TL. */
  onFail: "warn" | "alert";
};

/**
 * Hook event payload sent by Claude Code on stdin.
 * (Subset of fields we care about.)
 */
export type HookInput = {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; [k: string]: unknown };
  tool_response?: { success?: boolean; [k: string]: unknown };
};
