import { createSign } from "node:crypto";
import { getPool } from "./db";
import { encryptSecret, decryptSecret } from "./secrets";
import { log } from "./obs";

/**
 * GitHub App + GitLab OAuth plumbing for the one-button "Connect repository /
 * Connect account" UX.
 *
 * DEPLOYMENT MODEL: orchestra runs on each client's own server, so there is no
 * single vendor-owned App. Each deployment registers its OWN GitHub App (via
 * the manifest flow — see git-integration-api.ts) and/or GitLab OAuth app. The
 * resulting credentials live in `system_config` (secrets encrypted at rest),
 * managed by the instance admin. Env vars are still honoured as a fallback /
 * bootstrap, but the DB is the primary source so setup is in-app, not in YAML.
 *
 * This module owns: config read/write, minting short-lived GitHub App
 * installation tokens (RS256-signing an app JWT), and OAuth code exchange +
 * user fetch for both providers.
 */

// ─── Deployment config types ────────────────────────────────────────────────

export interface GitHubAppConfig {
  appId: string;
  /** App slug — the URL segment in github.com/apps/<slug>. For the install link. */
  appSlug: string;
  clientId: string;
  clientSecret: string;
  /** PEM private key (already normalized to real newlines). */
  privateKey: string;
  /** Optional — verifies inbound webhook HMAC if set. */
  webhookSecret?: string;
}

export interface GitLabOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** GitLab host origin, e.g. https://gitlab.com (no trailing slash). */
  baseUrl: string;
}

// system_config keys. Secret values are stored as AES-GCM ciphertext.
const K = {
  ghAppId: "github_app_id",
  ghSlug: "github_app_slug",
  ghClientId: "github_app_client_id",
  ghClientSecret: "github_app_client_secret", // encrypted
  ghPrivateKey: "github_app_private_key", // encrypted
  ghWebhookSecret: "github_app_webhook_secret", // encrypted
  glClientId: "gitlab_oauth_client_id",
  glClientSecret: "gitlab_oauth_client_secret", // encrypted
  glBaseUrl: "gitlab_oauth_base_url",
} as const;

/**
 * The app private key arrives as a real PEM with `\n`-escaped newlines (the
 * common "one env line" form) or as base64 of the whole PEM. Normalize both.
 */
function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("BEGIN")) return trimmed.replace(/\\n/g, "\n");
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf-8");
    if (decoded.includes("BEGIN")) return decoded;
  } catch { /* fall through */ }
  return trimmed.replace(/\\n/g, "\n");
}

// ─── system_config-backed loading (with env fallback + short cache) ─────────

let configCache: { map: Map<string, string>; at: number } | null = null;
const CONFIG_TTL_MS = 30_000;

/**
 * Read all git-integration keys from system_config. Resilient: a missing table
 * / DB error yields an empty map so env-only deployments (and unit tests with
 * no DB) still work via fallback. Cached for 30s; writers invalidate.
 */
async function loadConfigMap(): Promise<Map<string, string>> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.map;
  const map = new Map<string, string>();
  try {
    const keys = Object.values(K);
    const { rows } = await getPool().query<{ key: string; value: string }>(
      "SELECT key, value FROM system_config WHERE key = ANY($1)",
      [keys],
    );
    for (const r of rows) map.set(r.key, r.value);
  } catch (err) {
    log.debug({ err }, "git-app: system_config read failed; using env fallback");
  }
  configCache = { map, at: Date.now() };
  return map;
}

/** A secret field: DB ciphertext (decrypted) if present, else the env value. */
function readSecret(map: Map<string, string>, key: string, envVal: string | undefined): string | undefined {
  const enc = map.get(key);
  if (enc) {
    try {
      return decryptSecret(enc);
    } catch (err) {
      log.warn({ err, key }, "git-app: failed to decrypt stored secret (key rotated?)");
      return undefined;
    }
  }
  return envVal || undefined;
}

export async function githubAppConfig(): Promise<GitHubAppConfig | null> {
  const map = await loadConfigMap();
  const appId = map.get(K.ghAppId) ?? process.env.GITHUB_APP_ID;
  const appSlug = map.get(K.ghSlug) ?? process.env.GITHUB_APP_SLUG;
  const clientId = map.get(K.ghClientId) ?? process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = readSecret(map, K.ghClientSecret, process.env.GITHUB_APP_CLIENT_SECRET);
  const privateKeyRaw = readSecret(map, K.ghPrivateKey, process.env.GITHUB_APP_PRIVATE_KEY);
  const webhookSecret = readSecret(map, K.ghWebhookSecret, process.env.GITHUB_APP_WEBHOOK_SECRET);
  if (!appId || !appSlug || !clientId || !clientSecret || !privateKeyRaw) return null;
  return { appId, appSlug, clientId, clientSecret, privateKey: normalizePrivateKey(privateKeyRaw), webhookSecret };
}

export async function gitlabOAuthConfig(): Promise<GitLabOAuthConfig | null> {
  const map = await loadConfigMap();
  const clientId = map.get(K.glClientId) ?? process.env.GITLAB_OAUTH_CLIENT_ID;
  const clientSecret = readSecret(map, K.glClientSecret, process.env.GITLAB_OAUTH_CLIENT_SECRET);
  if (!clientId || !clientSecret) return null;
  const baseUrl = (map.get(K.glBaseUrl) ?? process.env.GITLAB_OAUTH_BASE_URL ?? "https://gitlab.com").replace(/\/+$/, "");
  return { clientId, clientSecret, baseUrl };
}

function invalidateConfigCache(): void {
  configCache = null;
}

// ─── Writers (admin-managed config) ─────────────────────────────────────────

async function upsert(key: string, value: string): Promise<void> {
  await getPool().query(
    `INSERT INTO system_config (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value],
  );
}

export async function saveGitHubAppConfig(cfg: GitHubAppConfig): Promise<void> {
  await upsert(K.ghAppId, cfg.appId);
  await upsert(K.ghSlug, cfg.appSlug);
  await upsert(K.ghClientId, cfg.clientId);
  await upsert(K.ghClientSecret, encryptSecret(cfg.clientSecret));
  await upsert(K.ghPrivateKey, encryptSecret(cfg.privateKey));
  if (cfg.webhookSecret) await upsert(K.ghWebhookSecret, encryptSecret(cfg.webhookSecret));
  invalidateConfigCache();
}

export async function saveGitLabOAuthConfig(cfg: GitLabOAuthConfig): Promise<void> {
  await upsert(K.glClientId, cfg.clientId);
  await upsert(K.glClientSecret, encryptSecret(cfg.clientSecret));
  await upsert(K.glBaseUrl, cfg.baseUrl.replace(/\/+$/, ""));
  invalidateConfigCache();
}

export async function clearGitIntegration(provider: "github" | "gitlab"): Promise<void> {
  const keys = provider === "github"
    ? [K.ghAppId, K.ghSlug, K.ghClientId, K.ghClientSecret, K.ghPrivateKey, K.ghWebhookSecret]
    : [K.glClientId, K.glClientSecret, K.glBaseUrl];
  await getPool().query("DELETE FROM system_config WHERE key = ANY($1)", [keys]);
  invalidateConfigCache();
}

/** Non-secret summary for the admin UI: configured? from where? which account? */
export async function gitIntegrationStatus(): Promise<{
  github: { configured: boolean; appSlug?: string; appId?: string; source: "db" | "env" | null };
  gitlab: { configured: boolean; baseUrl?: string; source: "db" | "env" | null };
}> {
  const map = await loadConfigMap();
  const gh = await githubAppConfig();
  const gl = await gitlabOAuthConfig();
  return {
    github: {
      configured: gh !== null,
      appSlug: gh?.appSlug,
      appId: gh?.appId,
      source: gh ? (map.has(K.ghAppId) ? "db" : "env") : null,
    },
    gitlab: {
      configured: gl !== null,
      baseUrl: gl?.baseUrl,
      source: gl ? (map.has(K.glClientId) ? "db" : "env") : null,
    },
  };
}

/** Test-only: drop memoized config + token caches so a test can swap state. */
export function _resetGitAppConfigForTesting(): void {
  invalidateConfigCache();
  installationTokenCache.clear();
}

// ─── GitHub App manifest conversion ─────────────────────────────────────────

/**
 * Exchange a manifest `code` (returned after the admin confirms app creation
 * on GitHub) for the new app's credentials, and persist them. This is what
 * makes per-deployment registration ~2 clicks: GitHub hands us the app id,
 * client secret, private key (pem) and webhook secret directly.
 */
export async function convertGitHubManifest(code: string): Promise<{ appSlug: string; htmlUrl: string }> {
  const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub manifest conversion failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const d = (await res.json()) as {
    id: number; slug: string; client_id: string; client_secret: string;
    pem: string; webhook_secret?: string; html_url: string;
  };
  await saveGitHubAppConfig({
    appId: String(d.id),
    appSlug: d.slug,
    clientId: d.client_id,
    clientSecret: d.client_secret,
    privateKey: d.pem,
    webhookSecret: d.webhook_secret,
  });
  return { appSlug: d.slug, htmlUrl: d.html_url };
}

// ─── GitHub App JWT + installation tokens ───────────────────────────────────

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Build a short-lived (≤10 min) RS256 app JWT. Backdate iat 60s for skew. */
function githubAppJwt(cfg: GitHubAppConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: cfg.appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(cfg.privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

interface CachedInstallationToken { token: string; expiresAt: number }
const installationTokenCache = new Map<number, CachedInstallationToken>();

/**
 * Mint (or reuse a cached) installation access token. GitHub installation
 * tokens live ~1h; we cache and reuse until 60s before expiry.
 */
export async function mintInstallationToken(installationId: number): Promise<string> {
  const cfg = await githubAppConfig();
  if (!cfg) throw new Error("GitHub App is not configured on this deployment");

  const cached = installationTokenCache.get(installationId);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubAppJwt(cfg)}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub installation token mint failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  installationTokenCache.set(installationId, {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  });
  return data.token;
}

/** Look up an installation's account login by id (for display in Settings). */
export async function getInstallationLogin(installationId: number): Promise<string | null> {
  const cfg = await githubAppConfig();
  if (!cfg) return null;
  const res = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: {
      Authorization: `Bearer ${githubAppJwt(cfg)}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) return null;
  const d = (await res.json()) as { account?: { login?: string } };
  return d.account?.login ?? null;
}

// ─── OAuth: authorize URLs ──────────────────────────────────────────────────

export async function githubInstallUrl(state: string): Promise<string> {
  const cfg = await githubAppConfig();
  if (!cfg) throw new Error("GitHub App is not configured on this deployment");
  return `https://github.com/apps/${cfg.appSlug}/installations/new?state=${encodeURIComponent(state)}`;
}

export async function githubUserAuthorizeUrl(state: string, redirectUri: string): Promise<string> {
  const cfg = await githubAppConfig();
  if (!cfg) throw new Error("GitHub App is not configured on this deployment");
  const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, state });
  return `https://github.com/login/oauth/authorize?${q.toString()}`;
}

export async function gitlabAuthorizeUrl(state: string, redirectUri: string): Promise<string> {
  const cfg = await gitlabOAuthConfig();
  if (!cfg) throw new Error("GitLab OAuth is not configured on this deployment");
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    scope: "api",
  });
  return `${cfg.baseUrl}/oauth/authorize?${q.toString()}`;
}

// ─── OAuth: code exchange + user fetch ──────────────────────────────────────

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  /** ms epoch, or null when the token does not expire. */
  expiresAt: number | null;
  scopes?: string;
}

export interface GitUser { login: string; id: string }

/**
 * POST an OAuth token request (code-exchange or refresh) and map the standard
 * `{access_token, refresh_token, expires_in, scope}` response into an
 * OAuthTokenSet. Shared by both providers and both grant types — the only
 * per-call differences are the endpoint URL and the body.
 */
async function oauthTokenRequest(
  url: string,
  body: Record<string, unknown>,
  label: string,
): Promise<OAuthTokenSet> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = (await res.json().catch(() => ({}))) as {
    access_token?: string; refresh_token?: string; expires_in?: number;
    scope?: string; error?: string; error_description?: string;
  };
  if (!res.ok || !d.access_token) {
    throw new Error(`${label} failed: ${d.error_description ?? d.error ?? res.status}`);
  }
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresAt: d.expires_in ? Date.now() + d.expires_in * 1000 : null,
    scopes: d.scope,
  };
}

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

export async function exchangeGitHubCode(code: string, redirectUri: string): Promise<OAuthTokenSet> {
  const cfg = await githubAppConfig();
  if (!cfg) throw new Error("GitHub App is not configured on this deployment");
  return oauthTokenRequest(GITHUB_TOKEN_URL, {
    client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirectUri,
  }, "GitHub code exchange");
}

export async function fetchGitHubUser(accessToken: string): Promise<GitUser> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub /user failed (${res.status})`);
  const d = (await res.json()) as { login: string; id: number };
  return { login: d.login, id: String(d.id) };
}

export async function exchangeGitLabCode(code: string, redirectUri: string): Promise<OAuthTokenSet> {
  const cfg = await gitlabOAuthConfig();
  if (!cfg) throw new Error("GitLab OAuth is not configured on this deployment");
  return oauthTokenRequest(`${cfg.baseUrl}/oauth/token`, {
    client_id: cfg.clientId, client_secret: cfg.clientSecret, code,
    grant_type: "authorization_code", redirect_uri: redirectUri,
  }, "GitLab code exchange");
}

export async function refreshGitLabToken(refreshToken: string): Promise<OAuthTokenSet> {
  const cfg = await gitlabOAuthConfig();
  if (!cfg) throw new Error("GitLab OAuth is not configured on this deployment");
  return oauthTokenRequest(`${cfg.baseUrl}/oauth/token`, {
    client_id: cfg.clientId, client_secret: cfg.clientSecret,
    refresh_token: refreshToken, grant_type: "refresh_token",
  }, "GitLab token refresh");
}

export async function refreshGitHubToken(refreshToken: string): Promise<OAuthTokenSet> {
  const cfg = await githubAppConfig();
  if (!cfg) throw new Error("GitHub App is not configured on this deployment");
  return oauthTokenRequest(GITHUB_TOKEN_URL, {
    client_id: cfg.clientId, client_secret: cfg.clientSecret,
    grant_type: "refresh_token", refresh_token: refreshToken,
  }, "GitHub token refresh");
}

export async function fetchGitLabUser(accessToken: string): Promise<GitUser> {
  const cfg = await gitlabOAuthConfig();
  const base = cfg?.baseUrl ?? "https://gitlab.com";
  const res = await fetch(`${base}/api/v4/user`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`GitLab /user failed (${res.status})`);
  const d = (await res.json()) as { username: string; id: number };
  return { login: d.username, id: String(d.id) };
}
