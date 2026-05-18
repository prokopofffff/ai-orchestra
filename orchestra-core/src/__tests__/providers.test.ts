import { describe, it, expect, afterEach } from "vitest";
import {
  providerFor,
  parseGitHubWebhook,
  parseGitLabWebhook,
  parseGhRepoUrl,
  parseGlProjectPath,
  GitHubProvider,
  GitLabProvider,
} from "../providers";

afterEach(() => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITLAB_TOKEN;
});

describe("providers — resolver", () => {
  it("detects GitHub from github.com URL", () => {
    const p = providerFor("https://github.com/o/r", { provider: { token: "gh" } });
    expect(p.kind).toBe("github");
  });

  it("detects GitLab from gitlab.com URL", () => {
    const p = providerFor("https://gitlab.com/group/repo", { provider: { token: "gl" } });
    expect(p.kind).toBe("gitlab");
  });

  it("uses explicit project settings.provider.type over URL detection", () => {
    const p = providerFor("https://custom.host/group/repo", {
      provider: { type: "gitlab", token: "gl", baseUrl: "https://custom.host" },
    });
    expect(p.kind).toBe("gitlab");
  });

  it("does NOT fall back to env.GITHUB_TOKEN — per-project only (cross-user safety)", () => {
    process.env.GITHUB_TOKEN = "env-token";
    expect(() => providerFor("https://github.com/o/r", null)).toThrow(/GitHub token not configured/);
  });

  it("does NOT fall back to env.GITLAB_TOKEN — per-project only (cross-user safety)", () => {
    process.env.GITLAB_TOKEN = "env-token";
    expect(() => providerFor("https://gitlab.com/group/repo", null)).toThrow(/GitLab token not configured/);
  });

  it("uses settings.provider.token", () => {
    const p = providerFor("https://github.com/o/r", {
      provider: { token: "setting-token" },
    }) as GitHubProvider;
    expect(p.tokenizeCloneUrl()).toContain("setting-token@github.com");
  });

  it("throws when token is missing on the project (no fallback path)", () => {
    expect(() => providerFor("https://github.com/o/r", null)).toThrow(/GitHub token not configured/);
  });

  it("throws when provider can't be detected (unknown hostname)", () => {
    expect(() => providerFor("https://example.com/stuff/repo", { provider: { token: "x" } }))
      .toThrow(/Cannot detect git provider/);
  });

  it("supports self-hosted GitLab via settings.provider.baseUrl", () => {
    const p = providerFor("https://git.company.internal/team/repo", {
      provider: { type: "gitlab", token: "tok", baseUrl: "https://git.company.internal" },
    }) as GitLabProvider;
    expect(p.kind).toBe("gitlab");
    expect(p.tokenizeCloneUrl()).toContain("oauth2:tok@git.company.internal");
  });
});

describe("providers — tokenizeCloneUrl", () => {
  it("GitHub injects https://<token>@", () => {
    const p = new GitHubProvider({ repoUrl: "https://github.com/o/r", token: "ghp_abc" });
    expect(p.tokenizeCloneUrl()).toBe("https://ghp_abc@github.com/o/r");
  });

  it("GitLab injects https://oauth2:<token>@", () => {
    const p = new GitLabProvider({
      repoUrl: "https://gitlab.com/group/repo",
      token: "glpat_xyz",
      baseUrl: "https://gitlab.com",
    });
    expect(p.tokenizeCloneUrl()).toBe("https://oauth2:glpat_xyz@gitlab.com/group/repo");
  });
});

describe("providers — URL parsing", () => {
  it("parseGhRepoUrl extracts owner/repo from github.com URL", () => {
    expect(parseGhRepoUrl("https://github.com/foo/bar")).toEqual({ owner: "foo", repo: "bar" });
    expect(parseGhRepoUrl("https://github.com/foo/bar.git")).toEqual({ owner: "foo", repo: "bar" });
  });

  it("parseGhRepoUrl throws on non-GitHub URL", () => {
    expect(() => parseGhRepoUrl("https://example.com/foo")).toThrow(/Cannot parse/);
  });

  it("parseGlProjectPath handles single- and nested-group paths", () => {
    expect(parseGlProjectPath("https://gitlab.com/group/repo")).toBe("group/repo");
    expect(parseGlProjectPath("https://gitlab.com/g1/g2/repo.git")).toBe("g1/g2/repo");
    expect(parseGlProjectPath("https://gitlab.company.com/team/project/")).toBe("team/project");
  });
});

describe("providers — GitHub webhook parser", () => {
  const hdr = (name: string, val: string) => ({ [name]: val } as Record<string, string>);

  it("maps pull_request opened → pr_opened", () => {
    const event = parseGitHubWebhook(hdr("x-github-event", "pull_request"), {
      action: "opened",
      pull_request: { title: "Feature", html_url: "https://github.com/o/r/pull/1", merged: false },
      repository: { html_url: "https://github.com/o/r" },
    });
    expect(event).toEqual({
      kind: "pr_opened", repoUrl: "https://github.com/o/r",
      prUrl: "https://github.com/o/r/pull/1", prTitle: "Feature",
    });
  });

  it("maps pull_request closed+merged → pr_merged", () => {
    const event = parseGitHubWebhook(hdr("x-github-event", "pull_request"), {
      action: "closed",
      pull_request: { title: "Feature", html_url: "https://github.com/o/r/pull/1", merged: true },
      repository: { html_url: "https://github.com/o/r" },
    });
    expect(event.kind).toBe("pr_merged");
  });

  it("maps pull_request closed without merge → pr_closed", () => {
    const event = parseGitHubWebhook(hdr("x-github-event", "pull_request"), {
      action: "closed",
      pull_request: { title: "F", html_url: "https://github.com/o/r/pull/1", merged: false },
      repository: { html_url: "https://github.com/o/r" },
    });
    expect(event.kind).toBe("pr_closed");
  });

  it("maps push → push with branch + commit count", () => {
    const event = parseGitHubWebhook(hdr("x-github-event", "push"), {
      ref: "refs/heads/main",
      commits: [{}, {}, {}],
      repository: { html_url: "https://github.com/o/r" },
    });
    expect(event).toEqual({
      kind: "push", repoUrl: "https://github.com/o/r", branch: "main", commits: 3,
    });
  });

  it("returns ignored for unknown event types", () => {
    const event = parseGitHubWebhook(hdr("x-github-event", "star"), {
      repository: { html_url: "https://github.com/o/r" },
    });
    expect(event.kind).toBe("ignored");
  });
});

describe("providers — GitLab webhook parser", () => {
  const hdr = (name: string, val: string) => ({ [name]: val } as Record<string, string>);

  it("maps merge_request action=open → pr_opened", () => {
    const event = parseGitLabWebhook(hdr("x-gitlab-event", "Merge Request Hook"), {
      object_kind: "merge_request",
      project: { web_url: "https://gitlab.com/g/r" },
      object_attributes: {
        action: "open", state: "opened",
        url: "https://gitlab.com/g/r/-/merge_requests/1", title: "Feature",
      },
    });
    expect(event).toEqual({
      kind: "pr_opened", repoUrl: "https://gitlab.com/g/r",
      prUrl: "https://gitlab.com/g/r/-/merge_requests/1", prTitle: "Feature",
    });
  });

  it("maps merge_request action=merge → pr_merged", () => {
    const event = parseGitLabWebhook(hdr("x-gitlab-event", "Merge Request Hook"), {
      object_kind: "merge_request",
      project: { web_url: "https://gitlab.com/g/r" },
      object_attributes: {
        action: "merge", state: "merged",
        url: "https://gitlab.com/g/r/-/merge_requests/1", title: "F",
      },
    });
    expect(event.kind).toBe("pr_merged");
  });

  it("maps push → push with branch + commits", () => {
    const event = parseGitLabWebhook(hdr("x-gitlab-event", "Push Hook"), {
      object_kind: "push",
      ref: "refs/heads/main",
      commits: [{}, {}],
      project: { web_url: "https://gitlab.com/g/r" },
    });
    expect(event).toEqual({
      kind: "push", repoUrl: "https://gitlab.com/g/r", branch: "main", commits: 2,
    });
  });

  it("returns ignored for unknown event kinds", () => {
    const event = parseGitLabWebhook(hdr("x-gitlab-event", "Issue Hook"), {
      object_kind: "issue",
      project: { web_url: "https://gitlab.com/g/r" },
    });
    expect(event.kind).toBe("ignored");
  });
});
