import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProjectSettings } from "@ai-orchestra/shared";

// Mock the credential sources so we can assert the precedence ordering in
// resolveGitCredential without a DB, network, or real GitHub App.
vi.mock("../git-app", () => ({
  githubAppConfig: vi.fn(() => ({ appId: "1" })),
  mintInstallationToken: vi.fn(async () => "INSTALL_TOKEN"),
}));
vi.mock("../user-git-identity", () => ({
  getValidUserToken: vi.fn(async () => null as string | null),
}));

import { resolveGitCredential } from "../providers/resolver";
import { mintInstallationToken, githubAppConfig } from "../git-app";
import { getValidUserToken } from "../user-git-identity";

const GH = "https://github.com/acme/widgets";

describe("resolveGitCredential precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (githubAppConfig as ReturnType<typeof vi.fn>).mockReturnValue({ appId: "1" });
    (mintInstallationToken as ReturnType<typeof vi.fn>).mockResolvedValue("INSTALL_TOKEN");
    (getValidUserToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  it("prefers the GitHub App installation token", async () => {
    const settings = { provider: { type: "github", githubInstallationId: 42 } } as unknown as ProjectSettings;
    const cred = await resolveGitCredential(GH, settings, "owner-1");
    expect(cred).toEqual({ token: "INSTALL_TOKEN", kind: "github", source: "installation" });
    expect(mintInstallationToken).toHaveBeenCalledWith(42);
    expect(getValidUserToken).not.toHaveBeenCalled();
  });

  it("falls back to the owner's user OAuth token when no installation", async () => {
    (getValidUserToken as ReturnType<typeof vi.fn>).mockResolvedValue("USER_TOKEN");
    const settings = { provider: { type: "github" } } as unknown as ProjectSettings;
    const cred = await resolveGitCredential(GH, settings, "owner-1");
    expect(cred).toEqual({ token: "USER_TOKEN", kind: "github", source: "user-oauth" });
    expect(getValidUserToken).toHaveBeenCalledWith("owner-1", "github");
  });

  it("falls back to the legacy PAT last", async () => {
    const settings = { provider: { type: "github", token: "ghp_legacy" } } as unknown as ProjectSettings;
    const cred = await resolveGitCredential(GH, settings, "owner-1");
    expect(cred).toEqual({ token: "ghp_legacy", kind: "github", source: "pat" });
  });

  it("returns null when nothing is configured", async () => {
    const settings = { provider: { type: "github" } } as unknown as ProjectSettings;
    const cred = await resolveGitCredential(GH, settings, "owner-1");
    expect(cred).toBeNull();
  });

  it("ignores the installation token when the App is not configured", async () => {
    (githubAppConfig as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (getValidUserToken as ReturnType<typeof vi.fn>).mockResolvedValue("USER_TOKEN");
    const settings = { provider: { type: "github", githubInstallationId: 42 } } as unknown as ProjectSettings;
    const cred = await resolveGitCredential(GH, settings, "owner-1");
    expect(cred?.source).toBe("user-oauth");
    expect(mintInstallationToken).not.toHaveBeenCalled();
  });

  it("uses the owner's GitLab OAuth token for gitlab repos", async () => {
    (getValidUserToken as ReturnType<typeof vi.fn>).mockResolvedValue("GL_TOKEN");
    const settings = { provider: {} } as unknown as ProjectSettings;
    const cred = await resolveGitCredential("https://gitlab.com/g/p", settings, "owner-1");
    expect(cred).toEqual({ token: "GL_TOKEN", kind: "gitlab", source: "user-oauth" });
    expect(getValidUserToken).toHaveBeenCalledWith("owner-1", "gitlab");
  });
});
