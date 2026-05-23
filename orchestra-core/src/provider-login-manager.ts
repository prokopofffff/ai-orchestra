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
 * Owns the lifecycle of `claude auth login` / `codex login --device-auth`
 * child processes spawned on behalf of dashboard users. Each
 * (projectId, provider) has at most one active session — starting a second
 * cancels the first.
 *
 * Both flows are headless-friendly (no localhost callback required), so
 * they work whether the dashboard user is on the same machine as
 * orchestra-core or hitting it over the network from a remote browser:
 *
 *   Codex (`codex login --device-auth`):
 *     - CLI prints a URL (https://auth.openai.com/codex/device) plus a
 *       short device code (e.g. "E23K-LK1V9") and starts polling.
 *     - Dashboard shows both. User opens URL on any browser, types the
 *       code, authorizes. The polling CLI gets the token and exits 0,
 *       leaving auth.json in $CODEX_HOME.
 *     - The status poll on the dashboard flips the badge to ✓.
 *
 *   Claude (`claude auth login`, spawned without a TTY):
 *     - CLI prints a paste-mode URL (redirect_uri=platform.claude.com,
 *       not localhost) and waits on stdin for the code.
 *     - Dashboard shows the URL + a paste field. User authorizes on
 *       claude.com, claude.com hands them a code, they paste it into
 *       the dashboard which POSTs to `/login/:sessionId/code`. We write
 *       the code to the child's stdin; CLI exchanges it, writes creds,
 *       exits 0.
 */
export type LoginProvider = "claude" | "codex";

/**
 * Public shape of a login flow. Discriminator: provider.
 * - Codex: shows `code` (typed on OpenAI's page), no submission step.
 * - Claude: shows URL only; user submits the returned `code` back via API.
 */
export type StartLoginResult =
  | { provider: "codex"; sessionId: string; url: string; code: string }
  | { provider: "claude"; sessionId: string; url: string; needsCodeSubmit: true };

type LoginSession = {
  id: string;
  provider: LoginProvider;
  projectId: string;
  child: ChildProcess;
  url: string;
  /** Codex device code shown to the user — not used by the server. */
  code?: string;
  timeoutHandle: NodeJS.Timeout;
};

/**
 * Why a session is no longer in `sessions`. Kept in a parallel map so a
 * /code POST that misses can tell the user "the CLI exited with code 1
 * (stderr: …)" rather than the opaque "session not found". Retained for
 * REASON_TTL_MS after the session dies — enough for a user retry,
 * dropped before unbounded growth.
 */
type SessionDeathReason = {
  cause: "exit" | "signal" | "timeout" | "cancelled" | "url_capture_failed";
  exitCode: number | null;
  signal: string | null;
  stderrTail: string;
  diedAt: number;
};

const REASON_TTL_MS = 30 * 60 * 1000;
const STDERR_TAIL_CAP = 4096;

const sessions = new Map<string, LoginSession>();
const byProjectProvider = new Map<string, string>();
const recentReasons = new Map<string, SessionDeathReason>();
const stderrTails = new Map<string, string>();

/** 5-minute hard limit on a login attempt — frees resources if the user walks away. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** How long to wait after spawn for the CLI to print its authorization URL. */
const URL_CAPTURE_TIMEOUT_MS = 10_000;

const CLAUDE_PASTE_URL_PATTERN = /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+/;
/** Codex device-auth always prints this exact URL (path is fixed by the API). */
const CODEX_DEVICE_URL_PATTERN = /https:\/\/auth\.openai\.com\/codex\/device/;
/** Codex device codes look like XXXX-XXXXX (8–10 chars, letters/digits). */
const CODEX_DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/;
/** Strip ANSI color codes so the regex doesn't get split across escapes. */
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function key(projectId: string, provider: LoginProvider): string {
  return `${projectId}::${provider}`;
}

export async function startProviderLogin(
  projectId: string,
  provider: LoginProvider,
): Promise<StartLoginResult> {
  const existing = byProjectProvider.get(key(projectId, provider));
  if (existing) cancelProviderLogin(existing);

  // Per-spawn env: scope OAuth to the project's credentials dir so creds
  // land in the right place. Strip ANTHROPIC_API_KEY so a stale value
  // can't divert Claude to API mode mid-flow.
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

  const bin = provider === "claude" ? resolveClaudeBin() : resolveCodexBin();
  // Codex needs the --device-auth flag to skip its localhost-callback
  // default. Claude detects no-TTY and auto-switches to paste-code mode.
  const args = provider === "claude" ? ["auth", "login"] : ["login", "--device-auth"];

  const child = spawn(bin, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let captured: { url: string; code?: string };
  try {
    captured = await captureForProvider(child, provider);
  } catch (err) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    throw err;
  }

  const sessionId = randomUUID();
  const timeoutHandle = setTimeout(() => {
    log.info({ sessionId, provider, projectId }, "provider login timed out — killing CLI");
    recordReason(sessionId, "timeout", null, null);
    try { child.kill("SIGTERM"); } catch { /* gone */ }
    cleanup(sessionId);
  }, LOGIN_TIMEOUT_MS);

  const session: LoginSession = {
    id: sessionId, provider, projectId, child,
    url: captured.url, code: captured.code, timeoutHandle,
  };
  sessions.set(sessionId, session);
  byProjectProvider.set(key(projectId, provider), sessionId);

  // Keep DRAINING stdout/stderr after the URL was captured. Without this
  // the OS pipe buffer (~64KB) fills with any further CLI output (status
  // prints, retry counters, progress dots) and the child blocks on write
  // — eventually exiting. Symptom: dashboard's /code POST returns "session
  // not found" because the close handler ran before the user could paste.
  // Maintain a rolling stderr tail for diagnostics on unexpected exits.
  child.stdout?.on("data", () => { /* drain only */ });
  child.stderr?.on("data", (b: Buffer) => {
    const prev = stderrTails.get(sessionId) ?? "";
    stderrTails.set(sessionId, (prev + b.toString("utf-8")).slice(-STDERR_TAIL_CAP));
  });

  child.once("close", (code, signal) => {
    const tail = stderrTails.get(sessionId) ?? "";
    log.info(
      { sessionId, provider, projectId, code, signal, stderrTail: tail.slice(-400) },
      "provider login CLI exited",
    );
    // Only record an exit reason if we haven't already classified (e.g. via
    // timeout / cancel). Lets the death-cause string stay accurate.
    if (!recentReasons.has(sessionId)) {
      recordReason(sessionId, signal ? "signal" : "exit", code, signal);
    }
    cleanup(sessionId);
  });

  if (provider === "codex") {
    return { provider: "codex", sessionId, url: captured.url, code: captured.code as string };
  }
  return { provider: "claude", sessionId, url: captured.url, needsCodeSubmit: true };
}

/**
 * Outcome of a /code submission. `ok=true` → bytes written to CLI stdin.
 * `ok=false` → session not found; `reason` carries the actionable
 * "why" (exit code, stderr tail, …) when we still have it cached.
 */
export type SubmitCodeResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Pipe a user-supplied code into the running Claude CLI. Codex doesn't need
 * this — its device-auth flow polls OpenAI directly, so we don't wire the
 * endpoint for it. Returns an actionable reason when the session is gone.
 */
export function submitProviderLoginCode(sessionId: string, code: string): SubmitCodeResult {
  const s = sessions.get(sessionId);
  if (!s) {
    const past = recentReasons.get(sessionId);
    if (!past) return { ok: false, reason: "Сессия логина не найдена (или истёк срок хранения причины)" };
    const ageMin = Math.round((Date.now() - past.diedAt) / 60_000);
    const tail = past.stderrTail ? ` — stderr: ${past.stderrTail.slice(-300).trim()}` : "";
    const code = past.exitCode !== null ? `exit=${past.exitCode}` : past.signal ? `signal=${past.signal}` : past.cause;
    return {
      ok: false,
      reason: `Сессия логина завершилась ${ageMin}мин назад (${code})${tail}`,
    };
  }
  if (s.provider !== "claude") return { ok: false, reason: "Этот провайдер не использует paste-режим" };
  if (!s.child.stdin || s.child.stdin.destroyed) {
    return { ok: false, reason: "stdin CLI уже закрыт" };
  }
  // Claude's prompt is line-buffered — a single write with a trailing newline
  // is enough. Don't end the stream; the CLI may print follow-up prompts on
  // bad codes and we want it to stay alive to surface them.
  s.child.stdin.write(code.trim() + "\n");
  return { ok: true };
}

export function cancelProviderLogin(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  recordReason(sessionId, "cancelled", null, null);
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
  // Drop the stderr tail buffer — recordReason already snapshotted it.
  stderrTails.delete(sessionId);
}

function recordReason(
  sessionId: string,
  cause: SessionDeathReason["cause"],
  exitCode: number | null,
  signal: string | null,
): void {
  const tail = stderrTails.get(sessionId) ?? "";
  recentReasons.set(sessionId, {
    cause, exitCode, signal,
    stderrTail: tail,
    diedAt: Date.now(),
  });
  // Cheap GC — keep recentReasons bounded so a long-running orchestra
  // doesn't accumulate dead-session debris.
  if (recentReasons.size > 50) {
    const cutoff = Date.now() - REASON_TTL_MS;
    for (const [id, r] of recentReasons) {
      if (r.diedAt < cutoff) recentReasons.delete(id);
    }
  }
}

/**
 * Read from the CLI's stdout/stderr until we've seen everything we need.
 * For Codex: URL **and** device code. For Claude: just the URL (the code
 * round-trips through the user). Strips ANSI so regexes match cleanly.
 */
function captureForProvider(
  child: ChildProcess,
  provider: LoginProvider,
): Promise<{ url: string; code?: string }> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;

    const finish = (err: Error | null, value?: { url: string; code?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(captureTimeout);
      child.stdout?.removeListener("data", onChunk);
      child.stderr?.removeListener("data", onChunk);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (err) reject(err);
      else resolve(value as { url: string; code?: string });
    };

    const tryMatch = (): void => {
      const clean = buf.replace(ANSI_PATTERN, "");
      if (provider === "claude") {
        const m = CLAUDE_PASTE_URL_PATTERN.exec(clean);
        if (m) finish(null, { url: m[0] });
      } else {
        const u = CODEX_DEVICE_URL_PATTERN.exec(clean);
        const c = CODEX_DEVICE_CODE_PATTERN.exec(clean);
        if (u && c) finish(null, { url: u[0], code: c[0] });
      }
    };

    const onChunk = (chunk: Buffer): void => {
      buf += chunk.toString("utf-8");
      tryMatch();
    };
    const onError = (err: Error): void => finish(err);
    const onClose = (code: number | null): void => {
      finish(new Error(
        `CLI логина завершился (код=${code}) до вывода данных авторизации. stdout/stderr: ${buf.slice(0, 400)}`,
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

// Best-effort shutdown — kill orphan CLIs when orchestra-core is going down.
process.on("beforeExit", () => {
  for (const s of sessions.values()) {
    try { s.child.kill("SIGTERM"); } catch { /* gone */ }
  }
});
