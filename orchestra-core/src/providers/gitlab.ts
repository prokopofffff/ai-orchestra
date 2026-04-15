import type {
  GitProvider, CreatePROptions, CreatePRResult, PRInfo, ReviewOptions,
  SubmitReviewResult, ReviewsPayload, WebhookParser,
} from "./types";

export interface GitLabConfig {
  repoUrl: string;
  token: string;
  /** Host URL of the GitLab instance, e.g. https://gitlab.com or https://gitlab.company.internal. */
  baseUrl: string;
}

/**
 * GitLab's REST API uses merge requests (MRs) instead of PRs. Terminology
 * in this file leans on the shared PR wording; behaviour maps 1:1.
 */
export class GitLabProvider implements GitProvider {
  readonly kind = "gitlab" as const;
  readonly repoUrl: string;
  private readonly apiBase: string;
  private readonly token: string;
  private readonly projectPath: string;   // owner/repo or group/subgroup/repo
  private projectIdCache: number | null = null;

  constructor(cfg: GitLabConfig) {
    this.repoUrl = cfg.repoUrl;
    this.token = cfg.token;
    this.apiBase = cfg.baseUrl.replace(/\/+$/, "") + "/api/v4";
    this.projectPath = parseGlProjectPath(cfg.repoUrl);
  }

  async createPR(opts: CreatePROptions): Promise<CreatePRResult> {
    const pid = await this.projectId();
    const d = await this.json<{ web_url: string; iid: number }>(
      "POST",
      `/projects/${pid}/merge_requests`,
      {
        source_branch: opts.head,
        target_branch: opts.base,
        title: opts.title,
        description: opts.body,
      },
    );
    return { url: d.web_url, number: d.iid };
  }

  async getPR(prUrl: string): Promise<PRInfo> {
    const pid = await this.projectId();
    const iid = parseMrIid(prUrl);
    const d = await this.json<{
      web_url: string; iid: number; state: string; title: string;
      source_branch: string; target_branch: string; sha: string | null;
      merged_at: string | null;
    }>("GET", `/projects/${pid}/merge_requests/${iid}`);

    return {
      url: d.web_url,
      number: d.iid,
      merged: d.merged_at !== null || d.state === "merged",
      state: d.state,
      title: d.title,
      headRef: d.source_branch,
      baseRef: d.target_branch,
      headSha: d.sha ?? "",
    };
  }

  async listPRs(opts: { state?: "open" | "all"; headBranchPrefix?: string } = {}): Promise<PRInfo[]> {
    const pid = await this.projectId();
    // GitLab state values: "opened" | "closed" | "merged" | "all"
    const state = opts.state === "open" ? "opened" : "all";
    const rows = await this.json<Array<{
      web_url: string; iid: number; state: string; title: string;
      source_branch: string; target_branch: string; sha: string | null;
      merged_at: string | null;
    }>>("GET", `/projects/${pid}/merge_requests?state=${state}&per_page=50`);

    return rows
      .filter((r) => !opts.headBranchPrefix || r.source_branch.startsWith(opts.headBranchPrefix))
      .map((r) => ({
        url: r.web_url, number: r.iid,
        merged: r.merged_at !== null || r.state === "merged",
        state: r.state, title: r.title,
        headRef: r.source_branch, baseRef: r.target_branch, headSha: r.sha ?? "",
      }));
  }

  async getPRDiff(prUrl: string): Promise<string> {
    const pid = await this.projectId();
    const iid = parseMrIid(prUrl);
    // GitLab returns diff blobs per-file; concatenate into a unified diff.
    const changes = await this.json<{ changes: Array<{ old_path: string; new_path: string; diff: string }> }>(
      "GET", `/projects/${pid}/merge_requests/${iid}/changes`,
    );
    return changes.changes
      .map((c) => `diff --git a/${c.old_path} b/${c.new_path}\n${c.diff}`)
      .join("\n");
  }

  async submitReview(opts: ReviewOptions): Promise<SubmitReviewResult> {
    const pid = await this.projectId();
    const iid = parseMrIid(opts.prUrl);

    // GitLab doesn't have a single "review" submit; we post a note + optionally
    // approve / unapprove. Inline comments use /discussions with position.
    if (opts.event === "APPROVE") {
      await this.json("POST", `/projects/${pid}/merge_requests/${iid}/approve`, {});
    } else if (opts.event === "REQUEST_CHANGES") {
      // GitLab has no "request changes" action; the convention is to
      // unapprove + post a note.
      await this.json("POST", `/projects/${pid}/merge_requests/${iid}/unapprove`, {}).catch(() => {});
    }

    const note = await this.json<{ id: number }>(
      "POST", `/projects/${pid}/merge_requests/${iid}/notes`, { body: opts.body },
    );

    if (opts.comments?.length) {
      // Best-effort inline comments via discussions. Needs latest diff refs.
      const mr = await this.json<{ diff_refs: { base_sha: string; head_sha: string; start_sha: string } }>(
        "GET", `/projects/${pid}/merge_requests/${iid}`,
      );
      for (const c of opts.comments) {
        await this.json("POST", `/projects/${pid}/merge_requests/${iid}/discussions`, {
          body: c.body,
          position: {
            position_type: "text",
            base_sha: mr.diff_refs.base_sha,
            head_sha: mr.diff_refs.head_sha,
            start_sha: mr.diff_refs.start_sha,
            new_path: c.path,
            new_line: c.line,
          },
        }).catch(() => { /* inline comments are best-effort */ });
      }
    }

    return { id: note.id, state: opts.event };
  }

  async getReviews(prUrl: string): Promise<ReviewsPayload> {
    const pid = await this.projectId();
    const iid = parseMrIid(prUrl);

    const [notes, discussions] = await Promise.all([
      this.json<Array<{ id: number; body: string; author: { username: string }; created_at: string; system: boolean }>>(
        "GET", `/projects/${pid}/merge_requests/${iid}/notes?per_page=100`,
      ),
      this.json<Array<{ notes: Array<{ body: string; author: { username: string }; created_at: string; position?: { new_path?: string; new_line?: number } }> }>>(
        "GET", `/projects/${pid}/merge_requests/${iid}/discussions?per_page=100`,
      ),
    ]);

    // Top-level notes (excluding system bot notes and discussion replies).
    const reviews = notes
      .filter((n) => !n.system)
      .map((n) => ({
        state: "commented",
        body: n.body,
        user: n.author.username,
        submittedAt: n.created_at,
      }));

    // Inline comments come from discussions with a position.
    const comments = discussions
      .flatMap((d) => d.notes)
      .filter((n) => n.position?.new_path)
      .map((n) => ({
        path: n.position!.new_path!,
        line: n.position!.new_line ?? null,
        body: n.body,
        user: n.author.username,
        createdAt: n.created_at,
      }));

    return { reviews, comments };
  }

  tokenizeCloneUrl(): string {
    // GitLab accepts `oauth2:<token>@...` for HTTPS clone auth.
    return this.repoUrl.replace(/^https:\/\//, `https://oauth2:${this.token}@`);
  }

  // ── internals ──

  private async projectId(): Promise<number> {
    if (this.projectIdCache !== null) return this.projectIdCache;
    // Encoded path is the canonical way to address a project.
    const encoded = encodeURIComponent(this.projectPath);
    const d = await this.json<{ id: number }>("GET", `/projects/${encoded}`);
    this.projectIdCache = d.id;
    return d.id;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/json",
      },
      body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({})) as T & { message?: unknown; error?: string };
    if (!res.ok) {
      const msg = typeof data.message === "string" ? data.message
        : typeof data.error === "string" ? data.error
        : `${res.status}`;
      throw new Error(`GitLab ${res.status}: ${msg}`);
    }
    return data;
  }
}

// ─── URL helpers ──────────────────────────────────────────────────────────

/** "https://gitlab.com/group/sub/repo" → "group/sub/repo" (strips optional .git) */
export function parseGlProjectPath(repoUrl: string): string {
  const m = repoUrl.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`Cannot parse GitLab project path from: ${repoUrl}`);
  return m[1];
}

export function parseMrIid(mrUrl: string): string {
  const m = mrUrl.match(/\/-?\/?merge_requests\/(\d+)/);
  if (!m) throw new Error(`Cannot parse MR IID from: ${mrUrl}`);
  return m[1];
}

// ─── Webhook parser ───────────────────────────────────────────────────────

export const parseGitLabWebhook: WebhookParser = (headers, body) => {
  const event = headerString(headers["x-gitlab-event"]);
  const payload = (body ?? {}) as {
    object_kind?: string;
    project?: { web_url?: string };
    object_attributes?: {
      url?: string; title?: string; state?: string; action?: string;
    };
    ref?: string;
    commits?: unknown[];
  };
  const repoUrl = payload.project?.web_url;
  if (!event || !repoUrl) return { kind: "ignored" };

  if (payload.object_kind === "merge_request" && payload.object_attributes) {
    const attrs = payload.object_attributes;
    const prUrl = attrs.url ?? "";
    const prTitle = attrs.title ?? "";
    if (attrs.action === "open" || attrs.action === "reopen") {
      return { kind: "pr_opened", repoUrl, prUrl, prTitle };
    }
    if (attrs.action === "merge" || attrs.state === "merged") {
      return { kind: "pr_merged", repoUrl, prUrl, prTitle };
    }
    if (attrs.action === "close") {
      return { kind: "pr_closed", repoUrl, prUrl, prTitle };
    }
  }

  if (payload.object_kind === "push") {
    const branch = payload.ref?.replace("refs/heads/", "") ?? "unknown";
    return { kind: "push", repoUrl, branch, commits: payload.commits?.length ?? 0 };
  }

  return { kind: "ignored" };
};

function headerString(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}
