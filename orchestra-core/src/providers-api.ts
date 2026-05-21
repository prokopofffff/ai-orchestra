import type { FastifyPluginAsync } from "fastify";
import { spawn } from "node:child_process";
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
  logoutClaude,
  logoutCodex,
} from "./per-project-creds";
import { startProviderLogin, cancelProviderLogin } from "./provider-login-manager";
import { resolveCodexBin } from "./bin-resolver";
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
    return {
      claude: {
        loggedIn: claudeLoggedIn(params.id),
        configDir: getClaudeConfigDir(params.id),
      },
      codex: {
        loggedIn: codexLoggedIn(params.id),
        mode: codexAuthMode(params.id),
        codexHome: getCodexHome(params.id),
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
      const { sessionId, url } = await startProviderLogin(params.id, params.provider);
      return { sessionId, url };
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
