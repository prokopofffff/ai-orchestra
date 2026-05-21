import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  ensureCredsDir,
  getClaudeConfigDir,
  getCodexHome,
} from "./per-project-creds";
import { resolveClaudeBin, resolveCodexBin } from "./bin-resolver";
import { log } from "./obs";

/**
 * Owns the lifecycle of in-flight `claude auth login` / `codex login` child
 * processes spawned on behalf of dashboard users. Each provider+project has
 * at most one active login session — starting a second cancels the first.
 *
 * Login UX (both providers):
 *   1. Dashboard hits POST /providers/:provider/login/start
 *   2. We spawn the CLI, capture the OAuth URL it prints, return it
 *   3. Dashboard opens the URL in a new browser tab
 *   4. User authorizes; vendor redirects to the CLI's local HTTP server
 *      (claude binds a random port like 54969; codex binds 1455)
 *   5. CLI receives the callback, writes credentials, exits
 *   6. Dashboard's existing /providers/status poll flips the badge to "✓"
 *
 * This only works when the user's browser can reach localhost on the
 * orchestra-core host. Fine for local dev (same machine). For remote
 * deployments we'd need to add the device-auth fallback (codex login
 * --device-auth and claude's paste-code mode) — additive change.
 */
export type LoginProvider = "claude" | "codex";

type LoginSession = {
  id: string;
  provider: LoginProvider;
  projectId: string;
  child: ChildProcess;
  url: string;
  timeoutHandle: NodeJS.Timeout;
};

const sessions = new Map<string, LoginSession>();
/**
 * Per (projectId, provider) → current sessionId. Lets a second "Authorize"
 * click cleanly cancel the first abandoned attempt before starting a new one.
 */
const byProjectProvider = new Map<string, string>();

/** 5-minute hard limit on a login attempt — frees resources if the user walks away. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** How long to wait after spawn for the CLI to print its authorization URL. */
const URL_CAPTURE_TIMEOUT_MS = 8_000;

const CLAUDE_URL_PATTERN = /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+/;
const CODEX_URL_PATTERN = /https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s]+/;

function key(projectId: string, provider: LoginProvider): string {
  return `${projectId}::${provider}`;
}

export type StartLoginResult = { sessionId: string; url: string };

export async function startProviderLogin(
  projectId: string,
  provider: LoginProvider,
): Promise<StartLoginResult> {
  // Idempotent: cancel any prior in-flight session for this project+provider.
  // Avoids accumulating zombie CLI children when a user repeatedly clicks.
  const existing = byProjectProvider.get(key(projectId, provider));
  if (existing) cancelProviderLogin(existing);

  // Per-spawn env: scope the OAuth to the project's credentials dir so the
  // resulting auth.json / .credentials.json lands in the right place. Strip
  // ANTHROPIC_API_KEY so a stale env var can't divert Claude to API mode.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (provider === "claude") {
    const dir = getClaudeConfigDir(projectId);
    ensureCredsDir(dir);
    env.CLAUDE_CONFIG_DIR = dir;
    delete env.ANTHROPIC_API_KEY;
  } else {
    const home = getCodexHome(projectId);
    ensureCredsDir(home);
    env.CODEX_HOME = home;
  }

  // resolveBin throws a Russian-localized error if the CLI isn't on PATH and
  // not at any of the common install locations — caller turns that into the
  // 500-response body.
  const bin = provider === "claude" ? resolveClaudeBin() : resolveCodexBin();
  const args = provider === "claude" ? ["auth", "login"] : ["login"];

  const child = spawn(bin, args, {
    env,
    // stdin pipe lets us close it if the CLI happens to fall through to the
    // paste-code fallback prompt (which would otherwise hang forever).
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pattern = provider === "claude" ? CLAUDE_URL_PATTERN : CODEX_URL_PATTERN;

  let url: string;
  try {
    url = await captureUrl(child, pattern);
  } catch (err) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    throw err;
  }

  const sessionId = randomUUID();
  const timeoutHandle = setTimeout(() => {
    log.info({ sessionId, provider, projectId }, "provider login timed out — killing CLI");
    try { child.kill("SIGTERM"); } catch { /* gone */ }
    cleanup(sessionId);
  }, LOGIN_TIMEOUT_MS);

  const session: LoginSession = {
    id: sessionId, provider, projectId, child, url, timeoutHandle,
  };
  sessions.set(sessionId, session);
  byProjectProvider.set(key(projectId, provider), sessionId);

  // Auto-cleanup when child exits naturally (successful OAuth, or vendor
  // rejected, or any other terminal cause). Dashboard's status poll detects
  // the success path; failures just leave loggedIn=false and the user clicks
  // Authorize again.
  child.once("close", (code) => {
    log.info({ sessionId, provider, projectId, code }, "provider login CLI exited");
    cleanup(sessionId);
  });

  return { sessionId, url };
}

/** External cancel (user closed modal). Returns true if a session was found. */
export function cancelProviderLogin(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  try { s.child.kill("SIGTERM"); } catch { /* gone */ }
  cleanup(sessionId);
  return true;
}

function cleanup(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  clearTimeout(s.timeoutHandle);
  sessions.delete(sessionId);
  if (byProjectProvider.get(key(s.projectId, s.provider)) === sessionId) {
    byProjectProvider.delete(key(s.projectId, s.provider));
  }
}

/**
 * Resolve as soon as we see the authorization URL in stdout/stderr. Rejects
 * with a clear error if the CLI exits before printing it (broken install,
 * missing creds dir, etc) or if it takes longer than URL_CAPTURE_TIMEOUT_MS.
 */
function captureUrl(child: ChildProcess, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;

    const finish = (err: Error | null, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(captureTimeout);
      child.stdout?.removeListener("data", onChunk);
      child.stderr?.removeListener("data", onChunk);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (err) reject(err);
      else resolve(value as string);
    };

    const onChunk = (chunk: Buffer): void => {
      buf += chunk.toString("utf-8");
      const m = pattern.exec(buf);
      if (m) finish(null, m[0]);
    };
    const onError = (err: Error): void => finish(err);
    const onClose = (code: number | null): void => {
      finish(new Error(
        `CLI логина завершился (код=${code}) до вывода URL авторизации. stdout/stderr: ${buf.slice(0, 400)}`,
      ));
    };

    const captureTimeout = setTimeout(
      () => finish(new Error(`CLI логина не вывел URL за ${URL_CAPTURE_TIMEOUT_MS}мс`)),
      URL_CAPTURE_TIMEOUT_MS,
    );

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

// Best-effort shutdown — kill any orphan CLIs when the orchestra process is
// going down. The CLI's local HTTP server holds a socket open; without this
// they'd outlive their parent until the OS reclaims them.
process.on("beforeExit", () => {
  for (const s of sessions.values()) {
    try { s.child.kill("SIGTERM"); } catch { /* gone */ }
  }
});
