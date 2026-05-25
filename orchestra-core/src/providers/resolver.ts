import type { ProjectSettings } from "@ai-orchestra/shared";
import { getPool } from "../db";
import { getProjectGitToken } from "../project-secrets";
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
 * Load the project by id, then resolve its provider.
 */
export async function providerForProject(projectId: string): Promise<GitProvider> {
  const { rows } = await getPool().query(
    "SELECT repo_url, settings FROM projects WHERE id = $1",
    [projectId],
  );
  if (!rows.length) throw new Error(`Project not found: ${projectId}`);
  const repoUrl = rows[0].repo_url as string | null;
  if (!repoUrl) throw new Error(`Project ${projectId} has no repo_url`);
  return providerFor(repoUrl, rows[0].settings as ProjectSettings | null);
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
