import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db";
import { projects } from "./db/schema";
import { currentUserId, isInstanceAdmin, requireInstanceAdmin } from "./auth";
import { userCanEditProject } from "./project-access";
import { mergeProjectSettings } from "./project-secrets";
import { rewriteOriginAuth } from "./repo-manager";
import { resolveProvider } from "./providers";
import { loadConfig } from "./config";
import type { ProjectSettings, GitProviderKind } from "@ai-orchestra/shared";
import {
  githubAppConfig, gitlabOAuthConfig,
  githubInstallUrl, githubUserAuthorizeUrl, gitlabAuthorizeUrl,
  exchangeGitHubCode, exchangeGitLabCode, fetchGitHubUser, fetchGitLabUser,
  getInstallationLogin,
  gitIntegrationStatus, convertGitHubManifest, saveGitLabOAuthConfig, clearGitIntegration,
} from "./git-app";
import {
  saveUserGitIdentity, deleteUserGitIdentity, listUserGitIdentities,
} from "./user-git-identity";
import { log } from "./obs";

/**
 * One-button "Connect repository / Connect account" flows for GitHub + GitLab.
 *
 * The dashboard never sees a token. Instead:
 *   - GET  /git/config            → what's available + what the user connected
 *   - POST /git/:provider/connect → returns the provider URL to open (the
 *                                    button's href); carries a signed `state`
 *   - GET  /git/:provider/callback → PUBLIC; the provider redirects here, we
 *                                    exchange the code / record the install,
 *                                    store creds, and bounce back to Settings
 *   - DELETE /git/:provider/identity         → disconnect account
 *   - POST   /projects/:id/git/disconnect-repo → forget the App installation
 *
 * `state` is a short-lived JWT (signed with the app's JWT secret) binding the
 * flow to a user + project, so the public callback can trust who it's for
 * without a session cookie surviving the cross-site redirect (CSRF-safe).
 */

interface OAuthState {
  userId: string;
  projectId: string | null;
  provider: GitProviderKind;
  target: "repo" | "account" | "manifest";
  /** ms-epoch expiry. */
  exp: number;
}

/**
 * Sign / verify the OAuth `state` as a self-contained HMAC token
 * (base64url(payload).base64url(sig)). We don't reuse @fastify/jwt here: its
 * JwtClaims type is augmented to the session/agent shapes and rejects this
 * payload. HMAC over the app secret gives the same CSRF + integrity guarantee
 * with no type wrangling. Reuses the validated JWT secret from config (single
 * source — no duplicated dev-secret literal, picks up the prod min-length guard).
 */
const cfg = loadConfig();
const STATE_SECRET = cfg.jwtSecret;
const CONFIGURED_PUBLIC_URL = cfg.publicUrl?.replace(/\/+$/, "");
const STATE_TTL_MS = 10 * 60_000;

function signState(s: Omit<OAuthState, "exp">): string {
  const payload = Buffer.from(JSON.stringify({ ...s, exp: Date.now() + STATE_TTL_MS })).toString("base64url");
  const sig = createHmac("sha256", STATE_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyState(token: string): OAuthState {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) throw new Error("malformed state");
  const expected = createHmac("sha256", STATE_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("bad signature");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as OAuthState;
  if (typeof decoded.exp !== "number" || decoded.exp < Date.now()) throw new Error("expired state");
  return decoded;
}

/** Public origin used to build redirect URIs. Prefers the configured value. */
function publicBase(req: FastifyRequest): string {
  if (CONFIGURED_PUBLIC_URL) return CONFIGURED_PUBLIC_URL;
  const proto = (req.headers["x-forwarded-proto"] as string) ?? req.protocol;
  const host = (req.headers["x-forwarded-host"] as string) ?? req.headers.host;
  return `${proto}://${host}`;
}

function callbackUri(req: FastifyRequest, provider: GitProviderKind): string {
  return `${publicBase(req)}/api/git/${provider}/callback`;
}

/**
 * Redirect the browser back to the dashboard Settings page with status params.
 * Shared by every OAuth/manifest callback; `detail` is truncated to keep the
 * URL sane.
 */
function redirectToSettings(
  reply: import("fastify").FastifyReply,
  req: FastifyRequest,
  params: Record<string, string>,
  detailKey?: string,
  detail?: string,
) {
  const q = new URLSearchParams(params);
  if (detailKey && detail) q.set(detailKey, detail.slice(0, 140));
  return reply.redirect(`${publicBase(req)}/settings?${q.toString()}`);
}

/** Merge a settings patch into a project's stored settings and persist it. */
async function patchProjectSettings(projectId: string, patch: Record<string, unknown>): Promise<void> {
  const merged = await mergeProjectSettings(projectId, patch);
  await getDb()
    .update(projects)
    .set({ settings: merged, updatedAt: sql`now()` })
    .where(eq(projects.id, projectId));
}

/** Best-effort: re-point a local checkout's origin at the freshly-resolved creds. */
async function rewriteOriginIfCloned(projectId: string): Promise<void> {
  try {
    const [row] = await getDb()
      .select({
        localPath: projects.localPath,
        repoUrl: projects.repoUrl,
        settings: projects.settings,
        ownerId: projects.ownerId,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row?.localPath || !row.repoUrl) return;
    const provider = await resolveProvider(row.repoUrl, row.settings as ProjectSettings | null, row.ownerId);
    await rewriteOriginAuth(row.localPath, provider.tokenizeCloneUrl());
  } catch (err) {
    log.warn({ err, projectId }, "git-connect: origin rewrite after connect skipped");
  }
}

const providerParam = z.object({ provider: z.enum(["github", "gitlab"]) });

export const gitConnectPlugin: FastifyPluginAsync = async (app) => {
  // ── Capabilities + what the current user has connected ──
  app.get("/git/config", async (request) => {
    const userId = currentUserId(request);
    const identities = await listUserGitIdentities(userId);
    const [gh, gl] = await Promise.all([githubAppConfig(), gitlabOAuthConfig()]);
    return {
      providers: {
        github: { appConfigured: gh !== null },
        gitlab: { oauthConfigured: gl !== null },
      },
      identities,
    };
  });

  // ── Start a connect flow → returns the URL the button should open ──
  app.post("/git/:provider/connect", async (request, reply) => {
    const { provider } = providerParam.parse(request.params);
    const body = z.object({
      projectId: z.string().uuid().optional(),
      target: z.enum(["repo", "account"]).default("account"),
    }).parse(request.body ?? {});
    const userId = currentUserId(request);

    if (body.projectId && !(await userCanEditProject(userId, body.projectId))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }

    const state = signState({
      userId,
      projectId: body.projectId ?? null,
      provider,
      target: body.target,
    });

    try {
      if (provider === "github") {
        if (!(await githubAppConfig())) return reply.code(400).send({ error: "GitHub App не настроен на сервере" });
        const url = body.target === "repo"
          ? await githubInstallUrl(state)
          : await githubUserAuthorizeUrl(state, callbackUri(request, "github"));
        return { url };
      }
      // GitLab: a single OAuth flow grants both repo access and identity.
      if (!(await gitlabOAuthConfig())) return reply.code(400).send({ error: "GitLab OAuth не настроен на сервере" });
      return { url: await gitlabAuthorizeUrl(state, callbackUri(request, "gitlab")) };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Public callback: provider redirects the user's browser here ──
  app.get("/git/:provider/callback", async (request, reply) => {
    const { provider } = providerParam.parse(request.params);
    const query = z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      installation_id: z.coerce.number().int().positive().optional(),
      setup_action: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    }).parse(request.query);

    const back = (status: "connected" | "error", detail?: string) =>
      redirectToSettings(reply, request, { git: status }, "git_detail", detail);

    if (query.error) return back("error", query.error_description ?? query.error);
    if (!query.state) return back("error", "missing state");

    let state: OAuthState;
    try {
      state = verifyState(query.state);
      if (state.provider !== provider) throw new Error("provider mismatch");
    } catch {
      return back("error", "invalid or expired state");
    }

    try {
      if (provider === "github") {
        // Repo access half: the App install redirect carries installation_id.
        if (query.installation_id && state.projectId) {
          const login = await getInstallationLogin(query.installation_id).catch(() => null);
          await patchProjectSettings(state.projectId, {
            provider: {
              type: "github",
              githubInstallationId: query.installation_id,
              githubInstallationLogin: login ?? undefined,
            },
          });
          await rewriteOriginIfCloned(state.projectId);
        }
        // Attribution half: a `code` is present when user-authorization ran
        // (always for the "account" button; also during install if the App
        // has "Request user authorization during installation" enabled).
        if (query.code) {
          const tokens = await exchangeGitHubCode(query.code, callbackUri(request, "github"));
          const user = await fetchGitHubUser(tokens.accessToken);
          await saveUserGitIdentity(state.userId, "github", tokens, user);
        }
        return back("connected");
      }

      // GitLab — single code-exchange flow.
      if (!query.code) return back("error", "missing code");
      const tokens = await exchangeGitLabCode(query.code, callbackUri(request, "gitlab"));
      const user = await fetchGitLabUser(tokens.accessToken);
      await saveUserGitIdentity(state.userId, "gitlab", tokens, user);
      if (state.projectId) {
        await patchProjectSettings(state.projectId, { provider: { type: "gitlab" } });
        await rewriteOriginIfCloned(state.projectId);
      }
      return back("connected");
    } catch (err) {
      log.warn({ err, provider }, "git-connect: callback failed");
      return back("error", err instanceof Error ? err.message : String(err));
    }
  });

  // ── Disconnect a user identity (the "Connect account" credential) ──
  app.delete("/git/:provider/identity", async (request) => {
    const { provider } = providerParam.parse(request.params);
    const userId = currentUserId(request);
    await deleteUserGitIdentity(userId, provider);
    return { ok: true };
  });

  // ── Forget the App installation bound to a project (repo access) ──
  app.post<{ Params: { id: string } }>("/projects/:id/git/disconnect-repo", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.params.id;
    if (!(await userCanEditProject(userId, projectId))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }
    await patchProjectSettings(projectId, {
      // null tombstones remove the keys via deepMergeSettings.
      provider: { githubInstallationId: null, githubInstallationLogin: null },
    });
    return { ok: true };
  });

  // ════════════════════════════════════════════════════════════════════════
  //  Admin: per-deployment integration setup (instance admin only)
  //  Each client deployment registers its OWN GitHub App / GitLab OAuth app.
  // ════════════════════════════════════════════════════════════════════════

  // Status the admin panel renders: configured? from DB or env? callback URLs
  // to paste into the provider, and whether ORCHESTRA_PUBLIC_URL is set.
  app.get("/git/integration", async (request, reply) => {
    if (!(await requireInstanceAdmin(request, reply))) return;
    const status = await gitIntegrationStatus();
    const base = publicBase(request);
    return {
      ...status,
      publicUrl: CONFIGURED_PUBLIC_URL ?? null,
      effectiveBaseUrl: base,
      callbackUrls: {
        github: `${base}/api/git/github/callback`,
        githubManifest: `${base}/api/git/github/manifest-callback`,
        gitlab: `${base}/api/git/gitlab/callback`,
        webhook: `${base}/api/git/webhook`,
      },
    };
  });

  // Build a GitHub App manifest the admin's browser POSTs to GitHub. GitHub
  // walks them through creating the app (name it, pick the account), then
  // redirects to manifest-callback with a code we convert into credentials.
  app.post("/git/github/manifest", async (request, reply) => {
    if (!(await requireInstanceAdmin(request, reply))) return;
    const body = z.object({ org: z.string().optional() }).parse(request.body ?? {});
    const userId = currentUserId(request);
    const base = publicBase(request);
    const host = (() => { try { return new URL(base).host; } catch { return "orchestra"; } })();

    const manifest = {
      name: `AI Orchestra (${host})`,
      url: base,
      hook_attributes: { url: `${base}/api/git/webhook`, active: true },
      redirect_url: `${base}/api/git/github/manifest-callback`,
      callback_urls: [`${base}/api/git/github/callback`],
      setup_url: `${base}/settings`,
      setup_on_update: true,
      public: false,
      // Repo-scoped least privilege for clone/push/PR + receiving PR/push events.
      default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      default_events: ["pull_request", "push"],
      // So the install flow ALSO returns a user token (PR/commit attribution).
      request_oauth_on_install: true,
    };

    const state = signState({ userId, projectId: null, provider: "github", target: "manifest" });
    const postUrl = body.org
      ? `https://github.com/organizations/${encodeURIComponent(body.org)}/settings/apps/new?state=${encodeURIComponent(state)}`
      : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
    return { postUrl, manifest: JSON.stringify(manifest) };
  });

  // PUBLIC callback after the admin confirms app creation on GitHub. The
  // `state` proves an admin initiated this; we re-check admin from the DB
  // before persisting the converted credentials.
  app.get("/git/github/manifest-callback", async (request, reply) => {
    const query = z.object({ code: z.string().optional(), state: z.string().optional() }).parse(request.query);
    const redirect = (status: string, detail?: string) =>
      redirectToSettings(reply, request, { git_setup: status }, "detail", detail);
    if (!query.code || !query.state) return redirect("error", "missing code/state");

    let state: OAuthState;
    try {
      state = verifyState(query.state);
      if (state.target !== "manifest" || state.provider !== "github") throw new Error("bad state");
    } catch {
      return redirect("error", "invalid or expired state");
    }
    if (!(await isInstanceAdmin(state.userId))) return redirect("error", "not an instance admin");

    try {
      const { appSlug } = await convertGitHubManifest(query.code);
      return redirect("github_ok", appSlug);
    } catch (err) {
      log.warn({ err }, "git-integration: manifest conversion failed");
      return redirect("error", err instanceof Error ? err.message : String(err));
    }
  });

  // Admin saves GitLab OAuth app credentials (no manifest equivalent exists).
  app.patch("/git/integration/gitlab", async (request, reply) => {
    if (!(await requireInstanceAdmin(request, reply))) return;
    const body = z.object({
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      baseUrl: z.string().url().optional(),
    }).parse(request.body);
    await saveGitLabOAuthConfig({
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      baseUrl: body.baseUrl ?? "https://gitlab.com",
    });
    return { ok: true };
  });

  // Admin removes a deployment integration (DB-stored creds only; env stays).
  app.delete("/git/integration/:provider", async (request, reply) => {
    if (!(await requireInstanceAdmin(request, reply))) return;
    const { provider } = providerParam.parse(request.params);
    await clearGitIntegration(provider);
    return { ok: true };
  });
};
