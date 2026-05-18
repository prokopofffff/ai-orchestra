import { getPool } from "./db";
import type { Config } from "./config";

export type ClaudeAuthResolution =
  | { mode: "max" }                              // SDK uses local `claude` CLI session
  | { mode: "api"; apiKey: string }              // SDK uses this API key
  | { mode: "api"; apiKey: null; reason: string }; // API mode chosen but no key on project

/**
 * Resolve Claude credentials for a given project WITHOUT mutating env.
 * Use this for preflight checks (project creation, dispatcher entry).
 *
 * Auth MODE precedence (highest first):
 *   1. settings.claude.auth   — per-project ("max" | "api")
 *   2. system_config.claude_auth — orchestra-wide default mode
 *   3. config.claudeAuth      — env default (CLAUDE_AUTH or "max")
 *
 * Auth CREDENTIAL: no fallback. When mode is "api", the key must come
 * from settings.claude.apiKey. Pulling from a shared system_config row
 * or env var was a cross-user leak.
 */
export async function resolveClaudeAuth(
  settings: unknown,
  config: Config,
): Promise<ClaudeAuthResolution> {
  // Mode (max vs api) is a deployment-wide preference, not a credential —
  // safe to share across users via system_config.
  const { rows: sysRows } = await getPool().query(
    "SELECT value FROM system_config WHERE key = 'claude_auth' LIMIT 1",
  ).catch(() => ({ rows: [] }));
  const sysClaudeAuth = sysRows[0]?.value as string | undefined;

  const projClaude = (settings as { claude?: { auth?: "max" | "api"; apiKey?: string } } | null)?.claude;
  const mode = (projClaude?.auth ?? sysClaudeAuth ?? config.claudeAuth) as "max" | "api";

  if (mode === "max") return { mode };
  const apiKey = projClaude?.apiKey;
  if (apiKey) return { mode, apiKey };
  return {
    mode,
    apiKey: null,
    reason:
      "Project is in API mode but has no Claude API key configured. Open Project Settings → Claude credentials to paste one, " +
      "or switch the mode to Max (uses the local `claude` CLI session).",
  };
}

/**
 * Apply the resolved auth to process.env. Must be called immediately
 * before spawning a run since the SDK reads ANTHROPIC_API_KEY at query()
 * time.
 *
 * When the effective auth is "max" we explicitly DELETE the env var —
 * otherwise an earlier project's API key could leak into this run and
 * bill the Max-subscription user's API quota instead of their plan.
 */
export async function applyClaudeAuthForProject(
  settings: unknown,
  config: Config,
): Promise<ClaudeAuthResolution> {
  const resolution = await resolveClaudeAuth(settings, config);
  if (resolution.mode === "api" && resolution.apiKey) {
    process.env.ANTHROPIC_API_KEY = resolution.apiKey;
  } else {
    delete process.env.ANTHROPIC_API_KEY;
  }
  return resolution;
}

/**
 * Cheap preflight check: can this project actually run a Claude agent?
 * Returns null when the project is ready to run; a user-facing reason
 * string otherwise. Callers post the reason to the chat as a system
 * message instead of letting the SDK fail mid-stream.
 *
 * Max-mode is treated as "trust the user" — there's no server-side way
 * to verify the local `claude` CLI session without burning a request.
 * If max-mode actually breaks at spawn time the SDK gives a clean error.
 */
export async function preflightClaudeAuth(
  settings: unknown,
  config: Config,
): Promise<string | null> {
  const r = await resolveClaudeAuth(settings, config);
  if (r.mode === "api" && r.apiKey === null) return r.reason;
  return null;
}
