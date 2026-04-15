import type { ProjectSettings } from "@ai-orchestra/shared";
import { getPool } from "../db";
import type { GitProvider, GitProviderKind } from "./types";
import { GitHubProvider } from "./github";
import { GitLabProvider } from "./gitlab";

/**
 * Resolve a GitProvider for a repo URL + optional project settings.
 *
 * Precedence (highest first):
 *   - settings.provider.type (explicit override)
 *   - hostname (github.com / gitlab.com)
 *   - custom host matches settings.provider.baseUrl hostname
 *
 * Auth:
 *   - settings.provider.token
 *   - process.env[GITHUB_TOKEN | GITLAB_TOKEN]
 *
 * Self-hosted base URL:
 *   - settings.provider.baseUrl
 *   - defaults: https://api.github.com (GitHub), https://gitlab.com (GitLab host)
 */
export function providerFor(repoUrl: string, settings: ProjectSettings | null): GitProvider {
  const cfg = settings?.provider;
  const kind: GitProviderKind = cfg?.type ?? detectKind(repoUrl, cfg?.baseUrl);

  if (kind === "github") {
    const token = cfg?.token ?? process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN not configured (or project settings.provider.token)");
    return new GitHubProvider({ repoUrl, token, baseUrl: cfg?.baseUrl });
  }

  const token = cfg?.token ?? process.env.GITLAB_TOKEN;
  if (!token) throw new Error("GITLAB_TOKEN not configured (or project settings.provider.token)");
  // GitLab baseUrl defaults to the repo's own host so /api/v4 works for
  // both gitlab.com and self-hosted without needing an explicit setting.
  const baseUrl = cfg?.baseUrl ?? hostFromUrl(repoUrl);
  return new GitLabProvider({ repoUrl, token, baseUrl });
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
