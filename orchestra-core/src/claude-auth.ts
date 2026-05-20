import { getPool } from "./db";
import type { Config } from "./config";
import {
  getClaudeConfigDir,
  ensureCredsDir,
  seedClaudeCredsFromHost,
  claudeLoggedIn,
} from "./per-project-creds";

/**
 * Per-spawn auth resolution for Claude. Returns the env vars to inject
 * into the child process AND a preflight reason if the project is not
 * usable (e.g. API mode chosen but no key persisted).
 *
 * Two modes:
 *   - `api` — env carries ANTHROPIC_API_KEY + CLAUDE_CONFIG_DIR pointed at
 *     the per-project dir (so any incidental cache/log writes stay scoped).
 *   - `max` — env carries CLAUDE_CONFIG_DIR only. The CLI reads
 *     `.credentials.json` from there (populated by `claude /login` or the
 *     one-time seed from `~/.claude/` on first spawn).
 *
 * Auth MODE precedence (highest first):
 *   1. settings.claude.auth   — per-project ("max" | "api")
 *   2. system_config.claude_auth — orchestra-wide default mode
 *   3. config.claudeAuth      — env default (CLAUDE_AUTH or "max")
 *
 * Credentials are STRICTLY per-project — no env-var or system_config
 * fallback for ANTHROPIC_API_KEY. The previous fallback model leaked one
 * user's key into another user's run.
 */
export type ClaudeAuthResolution = {
  /** Env vars to inject into the child spawn. `undefined` deletes a key. */
  env: Record<string, string | undefined>;
  /**
   * Set when the project is not yet usable (API mode without a key,
   * subscription mode without a login). Spawner short-circuits with this
   * reason instead of letting the CLI 401 mid-stream.
   */
  reason?: string;
};

export async function resolveClaudeAuth(
  projectId: string,
  settings: unknown,
  config: Config,
): Promise<ClaudeAuthResolution> {
  // Mode is a deployment-wide preference, not a credential — safe to share
  // across users via system_config.
  const { rows: sysRows } = await getPool().query(
    "SELECT value FROM system_config WHERE key = 'claude_auth' LIMIT 1",
  ).catch(() => ({ rows: [] }));
  const sysClaudeAuth = sysRows[0]?.value as string | undefined;

  const projClaude = (settings as { claude?: { auth?: "max" | "api"; apiKey?: string } } | null)?.claude;
  const mode = (projClaude?.auth ?? sysClaudeAuth ?? config.claudeAuth) as "max" | "api";

  const configDir = getClaudeConfigDir(projectId);
  ensureCredsDir(configDir);

  if (mode === "api") {
    const apiKey = projClaude?.apiKey;
    if (!apiKey) {
      return {
        env: {},
        reason:
          "Проект в режиме API, но Claude API-ключ не задан. Откройте Настройки проекта → Учётные данные Claude и вставьте ключ, " +
          "или переключитесь в режим Max (использует подписку Claude через `claude /login`).",
      };
    }
    return {
      env: {
        ANTHROPIC_API_KEY: apiKey,
        CLAUDE_CONFIG_DIR: configDir,
      },
    };
  }

  // Max / subscription mode. Try a one-time seed from ~/.claude/ — keeps
  // existing projects working without forcing every user to re-log per
  // project after the upgrade.
  if (!claudeLoggedIn(projectId)) {
    seedClaudeCredsFromHost(projectId);
  }
  if (!claudeLoggedIn(projectId)) {
    return {
      env: {},
      reason:
        "Проект в режиме Max (подписка), но не авторизован. " +
        "Откройте Настройки проекта → Учётные данные Claude → Авторизовать, чтобы запустить OAuth в браузере.",
    };
  }
  return {
    env: {
      CLAUDE_CONFIG_DIR: configDir,
      // Strip any inherited API key — would override the subscription login
      // and bill the API account instead of the user's plan.
      ANTHROPIC_API_KEY: undefined,
    },
  };
}

/**
 * Cheap preflight check: can this project actually run a Claude agent?
 * Returns null when ready; a user-facing reason string otherwise. Callers
 * post the reason to the chat as a system message instead of letting the
 * CLI fail mid-stream.
 */
export async function preflightClaudeAuth(
  projectId: string,
  settings: unknown,
  config: Config,
): Promise<string | null> {
  const r = await resolveClaudeAuth(projectId, settings, config);
  return r.reason ?? null;
}
