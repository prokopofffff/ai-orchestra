import { getPool } from "./db";
import type { Config } from "./config";

/**
 * Resolve Claude credentials for a given project and apply them to
 * process.env. The Claude Agent SDK reads ANTHROPIC_API_KEY at query()
 * time, so this MUST be called immediately before spawning the run.
 *
 * Auth MODE precedence (highest first):
 *   1. settings.claude.auth   — per-project ("max" | "api")
 *   2. system_config.claude_auth — orchestra-wide default mode
 *   3. config.claudeAuth      — env default (CLAUDE_AUTH or "max")
 *
 * Auth CREDENTIAL precedence: there is no fallback. When mode is "api",
 * the key MUST come from settings.claude.apiKey on that specific
 * project. Pulling from a shared system_config row or env var was a
 * cross-user leak — a token User A pasted into System Settings would
 * silently bill against User B's projects.
 *
 * When the effective auth is "max", the env var is DELETED — Max-mode
 * authenticates via the local `claude` CLI session. If an earlier
 * project's API key were still in env, the SDK might pick it up and
 * bill the subscription user's API account instead.
 */
export async function applyClaudeAuthForProject(
  settings: unknown,
  config: Config,
): Promise<{ auth: "max" | "api"; usingApiKey: boolean }> {
  // The mode (max vs api) is still a deployment-wide default that can be
  // set in System Settings — it's not a credential, just a preference,
  // so sharing across users is fine. Credentials are not.
  const { rows: sysRows } = await getPool().query(
    "SELECT value FROM system_config WHERE key = 'claude_auth' LIMIT 1",
  ).catch(() => ({ rows: [] }));
  const sysClaudeAuth = (sysRows[0]?.value as string | undefined);

  const projClaude = (settings as { claude?: { auth?: "max" | "api"; apiKey?: string } } | null)?.claude;
  const auth = (projClaude?.auth ?? sysClaudeAuth ?? config.claudeAuth) as "max" | "api";

  if (auth === "api") {
    const key = projClaude?.apiKey;
    if (key) {
      process.env.ANTHROPIC_API_KEY = key;
      return { auth, usingApiKey: true };
    }
    // No key on this project. Clear any leftover env so the SDK can't
    // silently fall back to another user's key that happened to be set
    // by an earlier run. The caller (agent-spawner / tech-lead-dispatcher)
    // sees usingApiKey=false and can escalate / refuse to run.
    delete process.env.ANTHROPIC_API_KEY;
    return { auth, usingApiKey: false };
  }

  // Max subscription path — SDK reads from claude CLI session, not env.
  delete process.env.ANTHROPIC_API_KEY;
  return { auth, usingApiKey: false };
}
