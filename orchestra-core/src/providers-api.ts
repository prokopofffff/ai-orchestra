import type { FastifyPluginAsync } from "fastify";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getPool } from "./db";
import { currentUserId } from "./auth";
import { userCanEditProject } from "./project-access";
import {
  getClaudeConfigDir,
  getCodexHome,
  ensureCredsDir,
  claudeLoggedIn,
  codexLoggedIn,
  codexAuthMode,
  hostClaudeAuthAvailable,
  hostCodexAuthAvailable,
  logoutClaude,
  logoutCodex,
} from "./per-project-creds";
import {
  startProviderLogin,
  cancelProviderLogin,
  submitProviderLoginCode,
} from "./provider-login-manager";
import { resolveCodexBin } from "./bin-resolver";
import { loadConfig } from "./config";
import { log } from "./obs";

/**
 * Per-project provider credential management. The dashboard hits these
 * endpoints to show "logged in / not" badges and to drive the in-browser
 * login flow.
 *
 * Subscription auth happens in the user's own browser via the vendor's
 * OAuth flow (we don't own the OAuth client). We surface the exact command
 * the user pastes into their terminal — `claude /login` or `codex login`
 * with the project's CLAUDE_CONFIG_DIR / CODEX_HOME — and poll the
 * status endpoint until the credentials file appears.
 *
 * Why no embedded terminal (xterm + node-pty): the OAuth flow opens a
 * browser anyway, and the CLI interaction is a single "press Enter to
 * confirm" + paste callback URL. Adding an embedded terminal would mean
 * a native-binding dep with cross-platform rebuild fragility, plus 800+
 * LOC of xterm wiring, for an experience that's only marginally smoother
 * than copy-paste-and-poll.
 */

const providerSchema = z.enum(["claude", "codex"]);

export const providersPlugin: FastifyPluginAsync = async (app) => {
  app.get("/projects/:id/providers/status", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const userId = currentUserId(req);
    if (!(await userCanEditProject(userId, params.id))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }
    // The badge has to match what `resolveClaudeAuth` will actually do at
    // spawn time, not just "is a creds file already in the per-project dir".
    // When the user picks "(наследовать)", no per-project file exists yet —
    // the first spawn would call `seedClaudeCredsFromHost`, which copies
    // `~/.claude/.credentials.json` into place. If the host has valid
    // creds, the next spawn WILL be authorized, so the badge should say
    // so now rather than confusingly waiting for an agent run.
    //
    // API mode skips this fallback: host OAuth creds are useless when
    // the project is configured to bill via an API key it doesn't have.
    const claudeMode = await resolveEffectiveClaudeMode(params.id);
    const claudePerProject = claudeLoggedIn(params.id);
    const claudeViaHost = !claudePerProject && claudeMode === "max" && hostClaudeAuthAvailable();

    const codexPerProject = codexLoggedIn(params.id);
    const codexViaHost = !codexPerProject && hostCodexAuthAvailable();

    return {
      claude: {
        loggedIn: claudePerProject || claudeViaHost,
        source: claudePerProject ? "per-project" : claudeViaHost ? "host" : null,
        configDir: getClaudeConfigDir(params.id),
        effectiveMode: claudeMode,
        hostHint: probeHostCredsFile(".claude", ".credentials.json"),
      },
      codex: {
        loggedIn: codexPerProject || codexViaHost,
        source: codexPerProject ? "per-project" : codexViaHost ? "host" : null,
        mode: codexAuthMode(params.id),
        codexHome: getCodexHome(params.id),
        hostHint: probeHostCredsFile(".codex", "auth.json"),
      },
    };
  });

  /**
   * Server-side OAuth start. Spawns `claude auth login` / `codex login` with
   * the project's CLAUDE_CONFIG_DIR / CODEX_HOME pre-set, captures the
   * authorization URL the CLI prints, and returns it for the dashboard to
   * open in a new tab. The CLI keeps running until the user authorizes (its
   * local HTTP server receives the OAuth callback) — then it exits cleanly
   * and the credentials land in the per-project dir. Dashboard's existing
   * /status poll flips the badge to ✓.
   *
   * Idempotent: a second call cancels the prior in-flight login for the
   * same project+provider before starting a new one.
   */
  app.post("/projects/:id/providers/:provider/login/start", async (req, reply) => {
    const params = z.object({
      id: z.string().uuid(),
      provider: providerSchema,
    }).parse(req.params);
    const userId = currentUserId(req);
    if (!(await userCanEditProject(userId, params.id))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }
    try {
      // Shape is provider-specific: Codex returns a device code the user
      // types on OpenAI's page; Claude returns a paste-code flag — the
      // dashboard surfaces an input box and POSTs the code to /code.
      return await startProviderLogin(params.id, params.provider);
    } catch (err) {
      log.warn({ err, projectId: params.id, provider: params.provider }, "provider login start failed");
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Cancel an in-flight login (user closed the modal). SIGTERMs the child;
   * any partial state in the per-project dir stays as-is and the next
   * /login/start call cleans it up implicitly.
   */
  app.post("/projects/:id/providers/:provider/login/:sessionId/cancel", async (req, reply) => {
    const params = z.object({
      id: z.string().uuid(),
      provider: providerSchema,
      sessionId: z.string().uuid(),
    }).parse(req.params);
    const userId = currentUserId(req);
    if (!(await userCanEditProject(userId, params.id))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }
    const cancelled = cancelProviderLogin(params.sessionId);
    return { cancelled };
  });

  /**
   * Submit a paste-mode code back to a running Claude login session. The
   * Codex flow polls OpenAI directly so it doesn't need this endpoint —
   * we 400 if anyone calls it for codex.
   */
  app.post("/projects/:id/providers/:provider/login/:sessionId/code", async (req, reply) => {
    const params = z.object({
      id: z.string().uuid(),
      provider: providerSchema,
      sessionId: z.string().uuid(),
    }).parse(req.params);
    const body = z.object({ code: z.string().min(1).max(200) }).parse(req.body);
    const userId = currentUserId(req);
    if (!(await userCanEditProject(userId, params.id))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }
    if (params.provider !== "claude") {
      return reply.code(400).send({ error: "Этот провайдер не использует paste-режим" });
    }
    const result = submitProviderLoginCode(params.sessionId, body.code);
    if (!result.ok) {
      return reply.code(404).send({ error: result.reason });
    }
    return { ok: true };
  });

  /**
   * Persist an API key for the chosen provider. For Claude this just writes
   * to settings.claude.apiKey; for Codex we ALSO invoke `codex login
   * --with-api-key` server-side because the codex client ignores the env
   * var at request time (empirically verified — see codex-auth.ts).
   */
  app.put("/projects/:id/providers/:provider/api-key", async (req, reply) => {
    const params = z.object({
      id: z.string().uuid(),
      provider: providerSchema,
    }).parse(req.params);
    const body = z.object({ apiKey: z.string().min(1) }).parse(req.body);

    const userId = currentUserId(req);
    if (!(await userCanEditProject(userId, params.id))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }

    const pool = getPool();
    const { rows } = await pool.query(
      "SELECT settings FROM projects WHERE id = $1 LIMIT 1",
      [params.id],
    );
    if (!rows.length) return reply.code(404).send({ error: "Проект не найден" });

    const settings = (rows[0].settings ?? {}) as Record<string, unknown>;
    if (params.provider === "claude") {
      const claude = (settings.claude ?? {}) as Record<string, unknown>;
      claude.auth = "api";
      claude.apiKey = body.apiKey;
      settings.claude = claude;
    } else {
      // Persist the key in settings AND prime the codex auth.json so the
      // first spawn doesn't need to provision it.
      const codex = (settings.codex ?? {}) as Record<string, unknown>;
      codex.auth = "api";
      codex.apiKey = body.apiKey;
      settings.codex = codex;
      try {
        await persistCodexApiKey(params.id, body.apiKey);
      } catch (err) {
        log.warn({ err, projectId: params.id }, "codex login --with-api-key failed during settings save");
        // Settings still get saved — the next spawn will retry persistence.
      }
    }
    await pool.query(
      "UPDATE projects SET settings = $1, updated_at = now() WHERE id = $2",
      [settings, params.id],
    );
    return { ok: true };
  });

  /** Log out — clears the per-project credentials file. */
  app.delete("/projects/:id/providers/:provider/login", async (req, reply) => {
    const params = z.object({
      id: z.string().uuid(),
      provider: providerSchema,
    }).parse(req.params);
    const userId = currentUserId(req);
    if (!(await userCanEditProject(userId, params.id))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }
    if (params.provider === "claude") logoutClaude(params.id);
    else logoutCodex(params.id);
    return { ok: true };
  });
};

/**
 * Same persistence flow as codex-auth uses internally — kept here so the
 * settings-save path doesn't need to spawn through a different code path.
 */
function persistCodexApiKey(projectId: string, apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let bin: string;
    try { bin = resolveCodexBin(); } catch (err) { reject(err); return; }
    const codexHome = getCodexHome(projectId);
    ensureCredsDir(codexHome);
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
 * Diagnostic on what the orchestra process actually finds at the user's
 * `~/.<dir>/<file>` (claude/credentials.json or codex/auth.json). The UI
 * surfaces this so a user who picked "(наследовать)" but sees the
 * "не настроено" badge can tell whether the file is missing, empty,
 * unreadable, or simply doesn't match the schema the validator expects.
 *
 * NEVER returns the token itself — only structural facts about the file.
 * That keeps the response safe to render in the dashboard even though the
 * underlying file is highly sensitive.
 */
function probeHostCredsFile(
  dirName: string,
  fileName: string,
): {
  home: string | null;
  path: string | null;
  exists: boolean;
  empty?: boolean;
  parseError?: string;
  /** Top-level JSON keys (NOT values) so the user can see the shape. */
  topLevelKeys?: string[];
  /** Per-schema validation flags so the user can see which validator branch fired. */
  hasOauthAccessToken?: boolean;
  hasTopLevelAccessToken?: boolean;
  hasApiKey?: boolean;
  hasCodexTokens?: boolean;
  hasOpenAiKey?: boolean;
} {
  const home = process.env.HOME ?? null;
  if (!home) return { home: null, path: null, exists: false };
  const full = path.join(home, dirName, fileName);
  if (!fs.existsSync(full)) return { home, path: full, exists: false };
  let raw: string;
  try { raw = fs.readFileSync(full, "utf-8"); }
  catch (err) { return { home, path: full, exists: true, parseError: `read failed: ${(err as Error).message}` }; }
  if (!raw.trim()) return { home, path: full, exists: true, empty: true };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) { return { home, path: full, exists: true, parseError: (err as Error).message }; }
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const tokens = obj.tokens as Record<string, unknown> | undefined;
  const oauth = obj.claudeAiOauth as Record<string, unknown> | undefined;
  return {
    home,
    path: full,
    exists: true,
    topLevelKeys: Object.keys(obj),
    hasOauthAccessToken: typeof oauth?.accessToken === "string" && (oauth.accessToken as string).length > 0,
    hasTopLevelAccessToken: typeof obj.accessToken === "string" && (obj.accessToken as string).length > 0,
    hasApiKey: typeof obj.apiKey === "string" && (obj.apiKey as string).length > 0,
    hasCodexTokens: typeof tokens?.access_token === "string" || typeof tokens?.id_token === "string",
    hasOpenAiKey: typeof obj.OPENAI_API_KEY === "string" && (obj.OPENAI_API_KEY as string).length > 0,
  };
}

/**
 * Mirror of `resolveClaudeAuth`'s mode resolution without the side-effect
 * of seeding host creds. Used by the status endpoint to figure out which
 * auth mode the next spawn WOULD pick, so we can predict whether host
 * fallback applies. Same precedence: project settings → system_config →
 * env default.
 */
async function resolveEffectiveClaudeMode(projectId: string): Promise<"max" | "api"> {
  const pool = getPool();
  const { rows: projRows } = await pool.query(
    "SELECT settings FROM projects WHERE id = $1 LIMIT 1",
    [projectId],
  );
  const projAuth = (projRows[0]?.settings as { claude?: { auth?: "max" | "api" } } | null)?.claude?.auth;
  if (projAuth === "max" || projAuth === "api") return projAuth;

  const { rows: sysRows } = await pool.query(
    "SELECT value FROM system_config WHERE key = 'claude_auth' LIMIT 1",
  ).catch(() => ({ rows: [] }));
  const sys = sysRows[0]?.value as string | undefined;
  if (sys === "max" || sys === "api") return sys;

  const cfg = loadConfig();
  return (cfg.claudeAuth === "api" ? "api" : "max");
}
