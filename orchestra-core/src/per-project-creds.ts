import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./obs";

/**
 * Root directory for per-project provider credentials. Each project gets a
 * subdirectory whose contents we point the CLIs at via env vars
 * (CLAUDE_CONFIG_DIR / CODEX_HOME). This isolates one project's Claude/Codex
 * login from another's — the pre-refactor model (single host-wide ~/.claude)
 * leaked credentials across users on shared hosts.
 *
 * Override with ORCHESTRA_CREDS_ROOT in deployments that mount a persistent
 * volume elsewhere (e.g. /var/lib/orchestra/creds in Docker).
 */
const CREDS_ROOT = process.env.ORCHESTRA_CREDS_ROOT
  ?? path.join(process.env.HOME ?? "/tmp", "orchestra-creds");

/** Per-project Claude credentials dir. Used as CLAUDE_CONFIG_DIR. */
export function getClaudeConfigDir(projectId: string): string {
  return path.join(CREDS_ROOT, projectId, ".claude");
}

/** Per-project Codex credentials dir. Used as CODEX_HOME. */
export function getCodexHome(projectId: string): string {
  return path.join(CREDS_ROOT, projectId, ".codex");
}

/**
 * Ensure the per-project creds dir exists with restrictive (0700) perms.
 * Idempotent — safe to call before every spawn. The 0700 matters: anything
 * looser lets other processes on the host read auth.json.
 */
export function ensureCredsDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is masked by umask — explicit chmod ensures 0700
  // regardless of how the orchestra process was started.
  try { fs.chmodSync(dir, 0o700); } catch { /* best-effort on platforms without chmod */ }
  // Also tighten the parent (project-id dir) — same reason.
  try { fs.chmodSync(path.dirname(dir), 0o700); } catch { /* best-effort */ }
}

/**
 * Files Claude CLI may touch inside CLAUDE_CONFIG_DIR. Only `.credentials.json`
 * carries actual auth tokens (oauth or api key). `.claude.json` is a state
 * file the CLI writes on first invocation regardless of whether the user
 * actually logged in — it contains migration flags, a derived userID, and
 * other settings, but no usable credentials. Checking it for "logged in"
 * produces false positives (the symptom that drove this fix: the badge
 * flipped to ✓ as soon as `claude auth login` started, before the user had
 * even seen the OAuth URL).
 */
const CLAUDE_CREDS_FILE = ".credentials.json";
/** Cleanup list — both files get removed on logout so the next attempt is fresh. */
const CLAUDE_CLEAN_FILES = [".credentials.json", ".claude.json"] as const;

/**
 * Validate that `.credentials.json` actually contains a usable token. Returns
 * the absolute path if so, null otherwise. Subscription flow writes
 * `claudeAiOauth.accessToken`; older / api-key flows use a top-level
 * `accessToken` or `apiKey`. Anything else (file present but empty/junk)
 * counts as not logged in.
 */
function findClaudeCredsFile(dir: string): string | null {
  const p = path.join(dir, CLAUDE_CREDS_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf-8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string };
      accessToken?: string;
      apiKey?: string;
    };
    const hasToken = Boolean(
      parsed.claudeAiOauth?.accessToken
        || parsed.accessToken
        || parsed.apiKey,
    );
    return hasToken ? p : null;
  } catch {
    return null;
  }
}

/**
 * One-time migration: when a project's per-project Claude dir is empty AND
 * the host has a default `~/.claude/` with a credentials file, seed the
 * per-project dir by copying it. Preserves the pre-refactor UX for existing
 * projects without forcing every user to manually re-log per project after
 * the upgrade.
 *
 * No-op when the per-project dir is already populated. Idempotent.
 *
 * Returns true if seeding happened, false otherwise.
 */
export function seedClaudeCredsFromHost(projectId: string): boolean {
  const target = getClaudeConfigDir(projectId);
  if (findClaudeCredsFile(target)) return false;

  const hostHome = process.env.HOME;
  if (!hostHome) return false;
  const hostAuth = findClaudeCredsFile(path.join(hostHome, ".claude"));
  if (!hostAuth) return false;

  ensureCredsDir(target);
  try {
    const targetAuth = path.join(target, CLAUDE_CREDS_FILE);
    fs.copyFileSync(hostAuth, targetAuth);
    fs.chmodSync(targetAuth, 0o600);
    log.info({ projectId, target }, "seeded per-project Claude creds from host");
    return true;
  } catch (err) {
    log.warn({ err, projectId }, "failed to seed Claude creds from host");
    return false;
  }
}

/** Same migration for Codex: copy ~/.codex/auth.json on first spawn. */
export function seedCodexCredsFromHost(projectId: string): boolean {
  const target = getCodexHome(projectId);
  const targetAuth = path.join(target, "auth.json");
  if (fs.existsSync(targetAuth)) return false;

  const hostHome = process.env.HOME;
  if (!hostHome) return false;
  const hostAuth = path.join(hostHome, ".codex", "auth.json");
  if (!fs.existsSync(hostAuth)) return false;

  ensureCredsDir(target);
  try {
    fs.copyFileSync(hostAuth, targetAuth);
    fs.chmodSync(targetAuth, 0o600);
    log.info({ projectId, target }, "seeded per-project Codex creds from host");
    return true;
  } catch (err) {
    log.warn({ err, projectId }, "failed to seed Codex creds from host");
    return false;
  }
}

/**
 * Auth-status helpers: are we logged in for this project for this provider?
 * Checked from API endpoints to drive the dashboard's auth-status badges
 * and from preflight to short-circuit a spawn that would 401 mid-stream.
 */
export function claudeLoggedIn(projectId: string): boolean {
  return findClaudeCredsFile(getClaudeConfigDir(projectId)) !== null;
}

/**
 * Validate that codex auth.json has actual tokens — the file gets written
 * empty/partial in some abort paths, so existence alone is not enough.
 */
export function codexLoggedIn(projectId: string): boolean {
  return readCodexAuth(getCodexHome(projectId)) !== null;
}

type CodexAuth = {
  OPENAI_API_KEY?: string;
  tokens?: { access_token?: string; id_token?: string };
  auth_mode?: string;
};

function readCodexAuth(home: string): CodexAuth | null {
  const p = path.join(home, "auth.json");
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf-8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as CodexAuth;
    const hasToken = Boolean(
      parsed.OPENAI_API_KEY
        || parsed.tokens?.access_token
        || parsed.tokens?.id_token,
    );
    return hasToken ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Host-side credential probes — does `~/.claude/` / `~/.codex/` carry a
 * credentials file we could seed into a per-project dir? Read-only check,
 * no copy. Used by the onboarding checklist to mark "AI provider configured"
 * for legacy users who have the host CLI logged in but haven't yet
 * triggered the per-project seed (which fires lazily on first spawn).
 */
export function hostClaudeAuthAvailable(): boolean {
  const hostHome = process.env.HOME;
  if (!hostHome) return false;
  return findClaudeCredsFile(path.join(hostHome, ".claude")) !== null;
}

export function hostCodexAuthAvailable(): boolean {
  const hostHome = process.env.HOME;
  if (!hostHome) return false;
  return fs.existsSync(path.join(hostHome, ".codex", "auth.json"));
}

/**
 * Inspect a Codex auth.json to determine whether it's an API-key login or a
 * ChatGPT subscription session. Used by the dashboard to badge the auth
 * mode independently from what the user configured.
 */
export function codexAuthMode(projectId: string): "apikey" | "chatgpt" | null {
  const parsed = readCodexAuth(getCodexHome(projectId));
  if (!parsed) return null;
  if (parsed.OPENAI_API_KEY || parsed.auth_mode === "apikey") return "apikey";
  return "chatgpt";
}

/** Best-effort credential reset (e.g. "log out" button). */
export function logoutClaude(projectId: string): void {
  const dir = getClaudeConfigDir(projectId);
  for (const name of CLAUDE_CLEAN_FILES) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

export function logoutCodex(projectId: string): void {
  const dir = getCodexHome(projectId);
  fs.rmSync(path.join(dir, "auth.json"), { force: true });
}

void os; // reserved — may use os.userInfo() for additional perm tightening later
