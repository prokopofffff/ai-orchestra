import type {
  GitProvider, CreatePROptions, CreatePRResult, PRInfo, ReviewOptions,
  SubmitReviewResult, ReviewsPayload, WebhookParser, MergePROptions, MergePRResult,
} from "./types";

export interface GitHubConfig {
  repoUrl: string;
  token: string;
  baseUrl?: string; // defaults to https://api.github.com; override for GHE
}

export class GitHubProvider implements GitProvider {
  readonly kind = "github" as const;
  readonly repoUrl: string;
  private readonly apiBase: string;
  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;

  constructor(cfg: GitHubConfig) {
    this.repoUrl = cfg.repoUrl;
    this.token = cfg.token;
    this.apiBase = (cfg.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    const { owner, repo } = parseGhRepoUrl(cfg.repoUrl);
    this.owner = owner;
    this.repo = repo;
  }

  async createPR(opts: CreatePROptions): Promise<CreatePRResult> {
    const data = await this.json<{ html_url: string; number: number; message?: string }>(
      "POST",
      `/repos/${this.owner}/${this.repo}/pulls`,
      opts,
    );
    return { url: data.html_url, number: data.number };
  }

  async getPR(prUrl: string): Promise<PRInfo> {
    const n = parsePrNumber(prUrl);
    const d = await this.json<{
      html_url: string; number: number; merged: boolean; state: string; title: string;
      head: { ref: string; sha: string }; base: { ref: string };
    }>("GET", `/repos/${this.owner}/${this.repo}/pulls/${n}`);
    return {
      url: d.html_url, number: d.number, merged: d.merged, state: d.state, title: d.title,
      headRef: d.head.ref, baseRef: d.base.ref, headSha: d.head.sha,
    };
  }

  async listPRs(opts: { state?: "open" | "all"; headBranchPrefix?: string } = {}): Promise<PRInfo[]> {
    const state = opts.state ?? "all";
    const rows = await this.json<Array<{
      html_url: string; number: number; merged_at: string | null; state: string; title: string;
      head: { ref: string; sha: string }; base: { ref: string };
    }>>("GET", `/repos/${this.owner}/${this.repo}/pulls?state=${state}&per_page=50`);

    return rows
      .filter((r) => !opts.headBranchPrefix || r.head.ref.startsWith(opts.headBranchPrefix))
      .map((r) => ({
        url: r.html_url, number: r.number, merged: r.merged_at !== null,
        state: r.state, title: r.title,
        headRef: r.head.ref, baseRef: r.base.ref, headSha: r.head.sha,
      }));
  }

  async getPRDiff(prUrl: string): Promise<string> {
    const n = parsePrNumber(prUrl);
    const res = await this.raw("GET", `/repos/${this.owner}/${this.repo}/pulls/${n}`, undefined, {
      Accept: "application/vnd.github.diff",
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    return res.text();
  }

  async submitReview(opts: ReviewOptions): Promise<SubmitReviewResult> {
    const n = parsePrNumber(opts.prUrl);
    const pr = await this.getPR(opts.prUrl);
    const body: Record<string, unknown> = {
      body: opts.body,
      event: opts.event,
      commit_id: pr.headSha,
    };
    if (opts.comments?.length) {
      body.comments = opts.comments.map((c) => ({ path: c.path, line: c.line, body: c.body }));
    }
    const d = await this.json<{ id: number; state: string }>(
      "POST", `/repos/${this.owner}/${this.repo}/pulls/${n}/reviews`, body,
    );
    return { id: d.id, state: d.state };
  }

  async getReviews(prUrl: string): Promise<ReviewsPayload> {
    const n = parsePrNumber(prUrl);
    const [reviews, comments] = await Promise.all([
      this.json<Array<{ state: string; body: string | null; user: { login: string }; submitted_at: string | null }>>(
        "GET", `/repos/${this.owner}/${this.repo}/pulls/${n}/reviews`,
      ),
      this.json<Array<{ path: string; line: number | null; original_line: number | null; body: string; user: { login: string }; created_at: string }>>(
        "GET", `/repos/${this.owner}/${this.repo}/pulls/${n}/comments`,
      ),
    ]);
    return {
      reviews: reviews.map((r) => ({
        state: r.state, body: r.body, user: r.user?.login ?? "", submittedAt: r.submitted_at,
      })),
      comments: comments.map((c) => ({
        path: c.path, line: c.line ?? c.original_line, body: c.body,
        user: c.user?.login ?? "", createdAt: c.created_at,
      })),
    };
  }

  async mergePR(prUrl: string, opts: MergePROptions = {}): Promise<MergePRResult> {
    const n = parsePrNumber(prUrl);
    const method = opts.method ?? "squash";
    const body: Record<string, unknown> = { merge_method: method };
    if (opts.commitTitle) body.commit_title = opts.commitTitle;
    const res = await this.raw("PUT", `/repos/${this.owner}/${this.repo}/pulls/${n}/merge`, body);
    // GitHub returns 200 on success, 405 when the PR isn't mergeable
    // (conflict / required checks pending / branch protection), 409 when
    // SHA has moved, 422 on validation errors. Surface those as soft
    // refusals so the caller falls back to the manual flow.
    if (res.ok) {
      const data = (await res.json()) as { sha?: string; merged?: boolean; message?: string };
      if (data.merged && data.sha) return { merged: true, sha: data.sha };
      return { merged: false, reason: data.message ?? "GitHub returned merged=false" };
    }
    if (res.status === 405 || res.status === 409 || res.status === 422) {
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      return { merged: false, reason: data.message ?? `GitHub ${res.status}` };
    }
    throw new Error(`GitHub ${res.status} on merge`);
  }

  tokenizeCloneUrl(): string {
    // HTTPS URLs like https://github.com/o/r(.git) — inject token.
    return this.repoUrl.replace(/^https:\/\//, `https://${this.token}@`);
  }

  // ── internals ──
  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const data = await res.json() as T & { message?: string; errors?: unknown };
    if (!res.ok) {
      throw new Error(`GitHub ${res.status}: ${data.message ?? "request failed"}`);
    }
    return data;
  }
  private raw(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
    return fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined,
    });
  }
}

// ─── URL helpers ──────────────────────────────────────────────────────────

export function parseGhRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const m = repoUrl.match(/github[^/]+\/([^/]+)\/([^/.]+)/);
  if (!m) throw new Error(`Cannot parse GitHub owner/repo from: ${repoUrl}`);
  return { owner: m[1], repo: m[2] };
}

export function parsePrNumber(prUrl: string): string {
  const m = prUrl.match(/\/pull\/(\d+)/);
  if (!m) throw new Error(`Cannot parse PR number from: ${prUrl}`);
  return m[1];
}

// ─── Webhook parser ───────────────────────────────────────────────────────

export const parseGitHubWebhook: WebhookParser = (headers, body) => {
  const event = headerString(headers["x-github-event"]);
  const payload = (body ?? {}) as {
    repository?: { html_url?: string };
    action?: string;
    pull_request?: { title: string; html_url: string; merged: boolean };
    ref?: string;
    commits?: unknown[];
  };
  const repoUrl = payload.repository?.html_url;
  if (!event || !repoUrl) return { kind: "ignored" };

  if (event === "pull_request" && payload.pull_request) {
    const pr = payload.pull_request;
    if (payload.action === "opened") {
      return { kind: "pr_opened", repoUrl, prUrl: pr.html_url, prTitle: pr.title };
    }
    if (payload.action === "closed") {
      return {
        kind: pr.merged ? "pr_merged" : "pr_closed",
        repoUrl, prUrl: pr.html_url, prTitle: pr.title,
      };
    }
  }

  if (event === "push") {
    const branch = payload.ref?.replace("refs/heads/", "") ?? "unknown";
    return { kind: "push", repoUrl, branch, commits: payload.commits?.length ?? 0 };
  }

  return { kind: "ignored" };
};

function headerString(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}
