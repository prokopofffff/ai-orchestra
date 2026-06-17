import type { ProjectSettings } from "@ai-orchestra/shared";
import { getPool } from "../db";
import { getProjectGitToken } from "../project-secrets";
import { mintInstallationToken, githubAppConfig } from "../git-app";
import { getValidUserToken } from "../user-git-identity";
import type { GitProvider, GitProviderKind } from "./types";
import { GitHubProvider } from "./github";
import { GitLabProvider } from "./gitlab";

/**
 * Resolve a GitProvider for a repo URL + project settings.
 *
 * Type precedence (highest first):
 *   - settings.provider.type (explicit override)
 *   - hostname (github.com / gitlab.com)
 *   - custom host matches settings.provider.baseUrl hostname
 *
 * Auth: STRICT per-project. settings.provider.token is the only source.
 * There is NO env-var fallback. Falling back to process.env.GITHUB_TOKEN
 * was a cross-user leak — a token set in .env (or, before, in System
 * Settings) would silently authorize requests for ANY user's project.
 * If you want to share a token across projects, paste it into each
 * project's Settings → Git provider token.
 *
 * Self-hosted base URL:
 *   - settings.provider.baseUrl
 *   - defaults: https://api.github.com (GitHub), https://gitlab.com (GitLab host)
 */
export function providerFor(repoUrl: string, settings: ProjectSettings | null): GitProvider {
  const cfg = settings?.provider;
  const kind: GitProviderKind = cfg?.type ?? detectKind(repoUrl, cfg?.baseUrl);

  const token = getProjectGitToken(settings);
  if (!token) {
    const which = kind === "github" ? "GitHub" : "GitLab";
    throw new Error(
      `${which} token not configured for this project. Open Project Settings → Git provider token to paste one.`,
    );
  }

  if (kind === "github") {
    return new GitHubProvider({ repoUrl, token, baseUrl: cfg?.baseUrl });
  }

  // GitLab baseUrl defaults to the repo's own host so /api/v4 works for
  // both gitlab.com and self-hosted without needing an explicit setting.
  const baseUrl = cfg?.baseUrl ?? hostFromUrl(repoUrl);
  return new GitLabProvider({ repoUrl, token, baseUrl });
}

/** Where a resolved git credential came from — for logging / status only. */
export type GitCredentialSource = "installation" | "user-oauth" | "pat";

export interface ResolvedGitCredential {
  token: string;
  kind: GitProviderKind;
  source: GitCredentialSource;
}

/**
 * Async credential resolution with the precedence the one-button UX needs:
 *
 *   1. GitHub App *installation* token — when the project carries a
 *      `githubInstallationId` and the deployment has an App configured. Minted
 *      fresh (cached ~1h) per call, so no long-lived secret is stored.
 *   2. The project owner's *user OAuth* token — the "Connect account"
 *      credential, refreshed transparently when expired. Used for GitLab
 *      repo access too (GitLab has no app-install model).
 *   3. Legacy per-project PAT — the advanced/self-hosted fallback.
 *
 * Returns null when none is available, so callers can degrade exactly as the
 * old sync `providerFor` did (which threw) — but here the caller decides.
 */
export async function resolveGitCredential(
  repoUrl: string,
  settings: ProjectSettings | null,
  ownerId: string | null | undefined,
): Promise<ResolvedGitCredential | null> {
  const cfg = settings?.provider;
  const kind: GitProviderKind = cfg?.type ?? detectKind(repoUrl, cfg?.baseUrl);

  if (kind === "github" && cfg?.githubInstallationId && (await githubAppConfig())) {
    try {
      const token = await mintInstallationToken(cfg.githubInstallationId);
      return { token, kind, source: "installation" };
    } catch {
      // Installation revoked / app misconfigured — fall through to the
      // owner's user token or PAT rather than hard-failing the operation.
    }
  }

  if (ownerId) {
    const userToken = await getValidUserToken(ownerId, kind);
    if (userToken) return { token: userToken, kind, source: "user-oauth" };
  }

  const pat = getProjectGitToken(settings);
  if (pat) return { token: pat, kind, source: "pat" };

  return null;
}

/**
 * Build a GitProvider from an already-resolved credential. Throws the same
 * actionable message as `providerFor` when `cred` is null. Use this when you've
 * called `resolveGitCredential` yourself and want to avoid resolving twice.
 */
export function providerFromCredential(
  repoUrl: string,
  settings: ProjectSettings | null,
  cred: ResolvedGitCredential | null,
): GitProvider {
  if (!cred) {
    const kind = settings?.provider?.type ?? detectKind(repoUrl, settings?.provider?.baseUrl);
    const which = kind === "github" ? "GitHub" : "GitLab";
    throw new Error(
      `No ${which} credential for this project. Connect the repository (one-click) ` +
        `in Project Settings → Git, or paste a token under Advanced.`,
    );
  }
  const cfg = settings?.provider;
  if (cred.kind === "github") return new GitHubProvider({ repoUrl, token: cred.token, baseUrl: cfg?.baseUrl });
  const baseUrl = cfg?.baseUrl ?? hostFromUrl(repoUrl);
  return new GitLabProvider({ repoUrl, token: cred.token, baseUrl });
}

/**
 * The git-provider env vars (`GIT_PROVIDER_TOKEN` + `GITHUB_TOKEN`/`GITLAB_TOKEN`)
 * an agent spawn should carry for an already-resolved credential. Empty when
 * there's no credential. Pure — pair with one `resolveGitCredential` call so a
 * spawn resolves the credential once and reuses it for both the clone URL and
 * the env.
 */
export function gitEnvFromCredential(cred: ResolvedGitCredential | null): Record<string, string> {
  if (!cred) return {};
  const env: Record<string, string> = { GIT_PROVIDER_TOKEN: cred.token };
  if (cred.kind === "gitlab") env.GITLAB_TOKEN = cred.token;
  else env.GITHUB_TOKEN = cred.token;
  return env;
}

/**
 * Async sibling of `providerFor`: resolves a provider using the full
 * credential precedence (installation token → owner user token → PAT).
 * Prefer this anywhere the project owner is known. Throws the same
 * actionable message as `providerFor` when nothing is configured.
 */
export async function resolveProvider(
  repoUrl: string,
  settings: ProjectSettings | null,
  ownerId: string | null | undefined,
): Promise<GitProvider> {
  return providerFromCredential(repoUrl, settings, await resolveGitCredential(repoUrl, settings, ownerId));
}

/**
 * Build the git-provider env vars an agent spawn should carry.
 *
 * Why: projects with a `local_path` skip the `ensureRepo` (HTTPS-with-token)
 * code path — the workdir is taken as-is, often with an SSH remote that
 * the container can't authenticate against ("Permission denied (publickey)").
 * Without these env vars the agent has the project's token sitting in
 * `settings.provider.token` but no way to use it: every `git fetch/push`
 * against the configured remote fails. Setting per-provider env vars
 * (`GITLAB_TOKEN` / `GITHUB_TOKEN`) is what conventional tooling expects
 * — glab, gh, hub, ci scripts, `curl --header "PRIVATE-TOKEN: …"`, …
 *
 * Returns an empty record when no token is configured (agent runs as
 * before, with no extra env).
 */
export function buildGitProviderEnv(
  repoUrl: string | null,
  settings: ProjectSettings | null | unknown,
): Record<string, string> {
  const token = getProjectGitToken(settings);
  if (!token) return {};
  // Generic alias for tooling that doesn't care about the provider.
  const env: Record<string, string> = { GIT_PROVIDER_TOKEN: token };
  if (repoUrl) {
    try {
      const p = providerFor(repoUrl, settings as ProjectSettings | null);
      if (p.kind === "gitlab") env.GITLAB_TOKEN = token;
      else if (p.kind === "github") env.GITHUB_TOKEN = token;
    } catch {
      // Unknown host or missing token — the generic var stays available.
    }
  }
  return env;
}

/**
 * Load the project by id, then resolve its provider using the full credential
 * precedence (installation token → owner user token → PAT).
 */
export async function providerForProject(projectId: string): Promise<GitProvider> {
  const { rows } = await getPool().query(
    "SELECT repo_url, settings, owner_id FROM projects WHERE id = $1",
    [projectId],
  );
  if (!rows.length) throw new Error(`Project not found: ${projectId}`);
  const repoUrl = rows[0].repo_url as string | null;
  if (!repoUrl) throw new Error(`Project ${projectId} has no repo_url`);
  return resolveProvider(
    repoUrl,
    rows[0].settings as ProjectSettings | null,
    rows[0].owner_id as string | null,
  );
}

// ─── URL sniffing ─────────────────────────────────────────────────────────

function detectKind(repoUrl: string, baseUrl?: string): GitProviderKind {
  const host = hostFromUrl(repoUrl);
  if (/(^|\.)github\.com$/i.test(hostname(host))) return "github";
  if (/(^|\.)gitlab\.com$/i.test(hostname(host))) return "gitlab";
  // Custom hosts: match against explicit baseUrl hostname.
  if (baseUrl) {
    const baseHost = hostname(baseUrl);
    if (/github/i.test(baseHost)) return "github";
    if (/gitlab/i.test(baseHost)) return "gitlab";
  }
  // Last-ditch heuristic on repo URL itself.
  if (/gitlab/i.test(host)) return "gitlab";
  if (/github/i.test(host)) return "github";
  throw new Error(`Cannot detect git provider from URL: ${repoUrl}. Set project settings.provider.type.`);
}

function hostFromUrl(url: string): string {
  const m = url.match(/^https?:\/\/([^/]+)/);
  return m ? `https://${m[1]}` : url;
}

function hostname(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}
