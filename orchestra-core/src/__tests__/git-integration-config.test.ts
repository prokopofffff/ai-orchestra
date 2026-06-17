import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { waitForDatabase, runMigrations } from "../db";
import {
  githubAppConfig, gitlabOAuthConfig,
  saveGitHubAppConfig, saveGitLabOAuthConfig,
  clearGitIntegration, gitIntegrationStatus, _resetGitAppConfigForTesting,
} from "../git-app";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

const ORIG = { ...process.env };

describe("git integration config — DB-backed with env fallback", () => {
  beforeAll(async () => {
    await waitForDatabase(DATABASE_URL);
    await runMigrations(DATABASE_URL);
    // Encryption key needed for storing secrets in system_config.
    process.env.ORCHESTRA_SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
  });

  beforeEach(async () => {
    await clearGitIntegration("github");
    await clearGitIntegration("gitlab");
    _resetGitAppConfigForTesting();
  });
  afterEach(async () => {
    await clearGitIntegration("github");
    await clearGitIntegration("gitlab");
    process.env = { ...ORIG };
    _resetGitAppConfigForTesting();
  });

  it("persists a GitHub App config and reads it back decrypted", async () => {
    await saveGitHubAppConfig({
      appId: "999",
      appSlug: "acme-orchestra",
      clientId: "Iv1.deadbeef",
      clientSecret: "shhh",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nKEY\n-----END RSA PRIVATE KEY-----",
      webhookSecret: "whsec",
    });
    _resetGitAppConfigForTesting();

    const cfg = await githubAppConfig();
    expect(cfg).toMatchObject({
      appId: "999", appSlug: "acme-orchestra", clientId: "Iv1.deadbeef",
      clientSecret: "shhh", webhookSecret: "whsec",
    });
    expect(cfg!.privateKey).toContain("BEGIN RSA PRIVATE KEY");

    const status = await gitIntegrationStatus();
    expect(status.github).toMatchObject({ configured: true, appSlug: "acme-orchestra", source: "db" });
  });

  it("DB config takes precedence over env", async () => {
    process.env.GITHUB_APP_ID = "env-id";
    process.env.GITHUB_APP_SLUG = "env-slug";
    process.env.GITHUB_APP_CLIENT_ID = "env-cid";
    process.env.GITHUB_APP_CLIENT_SECRET = "env-secret";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nENV\n-----END RSA PRIVATE KEY-----";
    await saveGitHubAppConfig({
      appId: "db-id", appSlug: "db-slug", clientId: "db-cid",
      clientSecret: "db-secret",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nDB\n-----END RSA PRIVATE KEY-----",
    });
    _resetGitAppConfigForTesting();

    const cfg = await githubAppConfig();
    expect(cfg!.appId).toBe("db-id");
    expect(cfg!.clientSecret).toBe("db-secret");
  });

  it("clearing DB config falls back to env (then null)", async () => {
    await saveGitHubAppConfig({
      appId: "1", appSlug: "s", clientId: "c", clientSecret: "x",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nK\n-----END RSA PRIVATE KEY-----",
    });
    _resetGitAppConfigForTesting();
    expect(await githubAppConfig()).not.toBeNull();

    await clearGitIntegration("github");
    _resetGitAppConfigForTesting();
    for (const k of ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY"]) {
      delete process.env[k];
    }
    _resetGitAppConfigForTesting();
    expect(await githubAppConfig()).toBeNull();
  });

  it("persists GitLab OAuth config (secret encrypted) and strips trailing slash", async () => {
    await saveGitLabOAuthConfig({ clientId: "glid", clientSecret: "glsec", baseUrl: "https://gl.example.com/" });
    _resetGitAppConfigForTesting();
    const cfg = await gitlabOAuthConfig();
    expect(cfg).toEqual({ clientId: "glid", clientSecret: "glsec", baseUrl: "https://gl.example.com" });
    const status = await gitIntegrationStatus();
    expect(status.gitlab).toMatchObject({ configured: true, source: "db" });
  });
});
