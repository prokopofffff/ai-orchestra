import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { waitForDatabase, runMigrations } from "../db";
import {
  githubAppConfig, gitlabOAuthConfig,
  githubInstallUrl, gitlabAuthorizeUrl, githubUserAuthorizeUrl,
  clearGitIntegration, _resetGitAppConfigForTesting,
} from "../git-app";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

// Config now reads system_config first with env fallback. These tests exercise
// the env-fallback path, so we clear any DB-stored integration first and set
// env vars. (URL builders + config probes don't sign, so no RSA key needed.)
const ORIG = { ...process.env };

describe("git-app config + authorize URLs (env fallback)", () => {
  beforeAll(async () => {
    await waitForDatabase(DATABASE_URL);
    await runMigrations(DATABASE_URL);
  });

  beforeEach(async () => {
    await clearGitIntegration("github");
    await clearGitIntegration("gitlab");
    _resetGitAppConfigForTesting();
  });
  afterEach(() => {
    process.env = { ...ORIG };
    _resetGitAppConfigForTesting();
  });

  it("returns null when nothing is configured, and URL builders throw", async () => {
    for (const k of [
      "GITHUB_APP_ID", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET",
      "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_SLUG",
      "GITLAB_OAUTH_CLIENT_ID", "GITLAB_OAUTH_CLIENT_SECRET",
    ]) delete process.env[k];
    _resetGitAppConfigForTesting();

    expect(await githubAppConfig()).toBeNull();
    expect(await gitlabOAuthConfig()).toBeNull();
    await expect(githubInstallUrl("s")).rejects.toThrow();
    await expect(gitlabAuthorizeUrl("s", "https://cb")).rejects.toThrow();
  });

  it("builds GitHub install + user-authorize URLs carrying the state", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_SLUG = "orchestra-bot";
    process.env.GITHUB_APP_CLIENT_ID = "Iv1.abc";
    process.env.GITHUB_APP_CLIENT_SECRET = "secret";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nMIIxxx\\n-----END RSA PRIVATE KEY-----";
    _resetGitAppConfigForTesting();

    const cfg = await githubAppConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.privateKey).toContain("\n");
    expect(cfg!.privateKey).not.toContain("\\n");

    expect(await githubInstallUrl("st8"))
      .toBe("https://github.com/apps/orchestra-bot/installations/new?state=st8");

    const authz = await githubUserAuthorizeUrl("st8", "https://orch.example/api/git/github/callback");
    expect(authz).toContain("https://github.com/login/oauth/authorize?");
    expect(authz).toContain("client_id=Iv1.abc");
    expect(authz).toContain("state=st8");
    expect(authz).toContain(encodeURIComponent("https://orch.example/api/git/github/callback"));
  });

  it("builds a GitLab authorize URL with api scope + custom base", async () => {
    process.env.GITLAB_OAUTH_CLIENT_ID = "glcid";
    process.env.GITLAB_OAUTH_CLIENT_SECRET = "glsec";
    process.env.GITLAB_OAUTH_BASE_URL = "https://gitlab.example.com/";
    _resetGitAppConfigForTesting();

    const cfg = await gitlabOAuthConfig();
    expect(cfg!.baseUrl).toBe("https://gitlab.example.com"); // trailing slash stripped

    const url = await gitlabAuthorizeUrl("st9", "https://orch/api/git/gitlab/callback");
    expect(url).toContain("https://gitlab.example.com/oauth/authorize?");
    expect(url).toContain("response_type=code");
    expect(url).toContain("scope=api");
    expect(url).toContain("state=st9");
  });
});
