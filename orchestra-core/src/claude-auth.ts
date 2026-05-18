import { getPool } from "./db";
import type { Config } from "./config";

/**
 * Resolve Claude credentials for a given project and apply them to
 * process.env. The Claude Agent SDK reads ANTHROPIC_API_KEY at query()
 * time, so this MUST be called immediately before spawning the run.
 *
 * Precedence (highest first):
 *   1. settings.claude.apiKey       — per-project API key
 *   2. system_config.claude_api_key — orchestra-wide API key (UI / System tab)
 *   3. process.env.ANTHROPIC_API_KEY — env / .env file
 *
 * settings.claude.auth (per-project) overrides system_config.claude_auth
 * (orchestra-wide), which overrides the config default ("max").
 *
 * When the effective auth is "max", the env var is DELETED — otherwise an
 * earlier project's API key could leak into this run and bill the
 * subscription user's API account. Max-mode authenticates via the local
 * `claude` CLI session, not env.
 */
export async function applyClaudeAuthForProject(
  settings: unknown,
  config: Config,
): Promise<{ auth: "max" | "api"; usingApiKey: boolean }> {
  const pool = getPool();
  const { rows: sysRows } = await pool.query(
    "SELECT key, value FROM system_config WHERE key IN ('claude_auth', 'claude_api_key') LIMIT 2",
  ).catch(() => ({ rows: [] }));
  const sysConfig = Object.fromEntries(
    (sysRows as { key: string; value: string }[]).map((r) => [r.key, r.value]),
  );

  const projClaude = (settings as { claude?: { auth?: "max" | "api"; apiKey?: string } } | null)?.claude;
  const auth = (projClaude?.auth ?? sysConfig.claude_auth ?? config.claudeAuth) as "max" | "api";

  if (auth === "api") {
    const key = projClaude?.apiKey ?? sysConfig.claude_api_key ?? process.env.ANTHROPIC_API_KEY;
    if (key) {
      process.env.ANTHROPIC_API_KEY = key;
      return { auth, usingApiKey: true };
    }
    return { auth, usingApiKey: false };
  }

  // Max subscription path — SDK reads from claude CLI session, not env.
  delete process.env.ANTHROPIC_API_KEY;
  return { auth, usingApiKey: false };
}

/**
 * Hydrate process.env from orchestra-wide system_config rows that other
 * code reads via env. Currently:
 *   - system_config.github_token → process.env.GITHUB_TOKEN
 *
 * Called at server boot and after each PATCH /system-config so the
 * provider resolver (which reads env synchronously) sees up-to-date
 * values without having to plumb DB access through every code path.
 *
 * settings.provider.token still wins for per-project overrides.
 */
export async function hydrateSystemEnv(): Promise<void> {
  const { rows } = await getPool().query(
    "SELECT key, value FROM system_config WHERE key IN ('github_token')",
  ).catch(() => ({ rows: [] }));
  for (const r of rows as { key: string; value: string }[]) {
    if (r.key === "github_token" && r.value) {
      process.env.GITHUB_TOKEN = r.value;
    }
  }
}
