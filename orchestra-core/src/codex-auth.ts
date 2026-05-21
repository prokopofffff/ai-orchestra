import { spawn } from "node:child_process";
import { resolveCodexBin } from "./bin-resolver";
import { getPool } from "./db";
import {
  getCodexHome,
  ensureCredsDir,
  seedCodexCredsFromHost,
  codexLoggedIn,
  codexAuthMode,
} from "./per-project-creds";

/**
 * Per-spawn auth resolution for Codex. Mirrors claude-auth.
 *
 * Two empirical quirks of `codex` (0.131.0) shape this:
 *   1. `OPENAI_API_KEY` env var is NOT consulted at request time. The CLI
 *      reads credentials from `$CODEX_HOME/auth.json` (populated by
 *      `codex login --with-api-key` or `codex login` for ChatGPT subscription).
 *      For API-key mode we persist the key into the per-project auth.json
 *      via `codex login --with-api-key`.
 *   2. The CLI exits 0 even on total auth failure — `preflightCodexAuth`
 *      checks file presence here so a misconfigured project doesn't fire a
 *      run that silently no-ops in the dashboard.
 */
export type CodexAuthResolution = {
  env: Record<string, string | undefined>;
  reason?: string;
};

export async function resolveCodexAuth(
  projectId: string,
  settings: unknown,
): Promise<CodexAuthResolution> {
  const projCodex = (settings as { codex?: { auth?: "subscription" | "api"; apiKey?: string } } | null)?.codex;
  // Subscription is the default — most early adopters will have a ChatGPT
  // subscription before they have an OpenAI API key.
  const mode = projCodex?.auth ?? "subscription";

  const codexHome = getCodexHome(projectId);
  ensureCredsDir(codexHome);

  if (mode === "api") {
    const apiKey = projCodex?.apiKey;
    if (!apiKey) {
      return {
        env: {},
        reason:
          "Проект в режиме API для Codex, но OpenAI API-ключ не задан. " +
          "Откройте Настройки проекта → Учётные данные Codex и вставьте ключ, или переключитесь в режим подписки ChatGPT.",
      };
    }
    // Persist via `codex login --with-api-key` if not already done, OR if
    // the persisted key doesn't match (rotation). Idempotent in practice
    // — re-persisting the same key is cheap and avoids drift.
    if (codexAuthMode(projectId) !== "apikey" || !codexLoggedIn(projectId)) {
      await persistCodexApiKey(codexHome, apiKey);
    }
    return { env: { CODEX_HOME: codexHome } };
  }

  // Subscription mode. Try a one-time host-credential seed for backward compat.
  if (!codexLoggedIn(projectId)) {
    seedCodexCredsFromHost(projectId);
  }
  if (!codexLoggedIn(projectId)) {
    return {
      env: {},
      reason:
        "Проект в режиме подписки Codex, но не авторизован. " +
        "Откройте Настройки проекта → Учётные данные Codex → Авторизовать, чтобы запустить OAuth ChatGPT.",
    };
  }
  return { env: { CODEX_HOME: codexHome } };
}

export async function preflightCodexAuth(
  projectId: string,
  settings: unknown,
): Promise<string | null> {
  const r = await resolveCodexAuth(projectId, settings);
  return r.reason ?? null;
}

/**
 * Pipe the user's API key into `codex login --with-api-key`. Codex stores
 * it in `$CODEX_HOME/auth.json` with mode 0600. We can't use the OPENAI_API_KEY
 * env var because the codex client ignores it (verified empirically).
 *
 * Resolves on the CLI's exit (typically <100ms). Rejects if the CLI exits
 * non-zero — the caller surfaces the failure as a preflight reason.
 */
function persistCodexApiKey(codexHome: string, apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let bin: string;
    try { bin = resolveCodexBin(); } catch (err) { reject(err); return; }
    const child = spawn(bin, ["login", "--with-api-key"], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (b) => { stderr += b.toString(); });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`codex login --with-api-key exited ${code}: ${stderr.slice(0, 300)}`));
    });
    child.stdin?.end(apiKey + "\n");
  });
}

/**
 * Snapshot for the dashboard's auth-status badge. Cheap, no spawn — just
 * file existence + a small JSON read.
 */
export function codexAuthSnapshot(projectId: string): {
  loggedIn: boolean;
  mode: "apikey" | "chatgpt" | null;
} {
  const loggedIn = codexLoggedIn(projectId);
  return { loggedIn, mode: loggedIn ? codexAuthMode(projectId) : null };
}

// Internal: kept so the dashboard /providers/status API can use a single
// per-provider helper without importing per-project-creds directly.
export { codexLoggedIn };

// system_config currently has no orchestra-wide Codex mode default — Codex
// is per-project from day one. Reserved here so we can mirror the Claude
// system_config pattern if a multi-project default becomes useful.
void getPool;
