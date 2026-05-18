/**
 * Shared types for git provider implementations (GitHub, GitLab, …).
 * Each provider implementation wraps its upstream REST API behind this
 * interface so the rest of the codebase (pr-api, pr-watcher, webhooks)
 * doesn't need to know which vendor it's talking to.
 */

import type { GitProviderKind } from "@ai-orchestra/shared";

export type { GitProviderKind };

export interface CreatePROptions {
  title: string;
  body: string;
  head: string;  // source branch
  base: string;  // target branch
}

export interface CreatePRResult {
  url: string;
  number: number;
}

export interface PRInfo {
  url: string;
  number: number;
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  state: string;       // provider-native, e.g. "open" / "closed" / "merged"
  title?: string;
}

export interface ReviewOptions {
  prUrl: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  comments?: Array<{ path: string; line: number; body: string }>;
}

export interface SubmitReviewResult {
  id: number | string;
  state?: string;
}

export interface MergePROptions {
  /** Merge strategy. "squash" is the most conservative default for auto-merge. */
  method?: "merge" | "squash" | "rebase";
  /** Optional commit message override; provider may use the PR title if omitted. */
  commitTitle?: string;
}

/**
 * Result of an auto-merge attempt. We return a discriminated union rather
 * than throwing for the common "PR isn't mergeable" cases (conflict, branch
 * protection, failed checks) so callers can take the no-auto-merge fallback
 * without distinguishing exception types.
 */
export type MergePRResult =
  | { merged: true;  sha: string }
  | { merged: false; reason: string };

export interface NormalizedReview {
  state: string;
  body: string | null;
  user: string;
  submittedAt: string | null;
}

export interface NormalizedComment {
  path: string;
  line: number | null;
  body: string;
  user: string;
  createdAt: string;
}

export interface ReviewsPayload {
  reviews: NormalizedReview[];
  comments: NormalizedComment[];
}

/**
 * Normalized webhook event. Callers switch on `kind`; provider-specific
 * nuances are absorbed in the parser.
 */
export type WebhookEvent =
  | { kind: "pr_opened"; repoUrl: string; prUrl: string; prTitle: string }
  | { kind: "pr_merged"; repoUrl: string; prUrl: string; prTitle: string }
  | { kind: "pr_closed"; repoUrl: string; prUrl: string; prTitle: string }
  | { kind: "push";      repoUrl: string; branch: string; commits: number }
  | { kind: "ignored" };

export interface GitProvider {
  readonly kind: GitProviderKind;
  /** Canonical HTML URL of the repo (https://host/owner/repo). */
  readonly repoUrl: string;

  createPR(opts: CreatePROptions): Promise<CreatePRResult>;
  getPR(prUrl: string): Promise<PRInfo>;
  /** List open (or all) PRs. `headBranchPrefix` narrows by source branch. */
  listPRs(opts?: { state?: "open" | "all"; headBranchPrefix?: string }): Promise<PRInfo[]>;
  getPRDiff(prUrl: string): Promise<string>;
  submitReview(opts: ReviewOptions): Promise<SubmitReviewResult>;
  getReviews(prUrl: string): Promise<ReviewsPayload>;
  /**
   * Merge a PR via the provider's API. Returns `{merged:false, reason}` for
   * expected refusals (conflicts, branch protection, missing required checks);
   * throws only on transport-level / auth failures.
   */
  mergePR(prUrl: string, opts?: MergePROptions): Promise<MergePRResult>;

  /**
   * Return a git-clone-friendly URL with auth embedded.
   * (For HTTPS flows — SSH is a separate concern we don't address.)
   */
  tokenizeCloneUrl(): string;
}

/**
 * Parse a webhook request. Kept as a module-level function per provider
 * (not on GitProvider) because webhooks arrive before a project is resolved
 * — the parser figures out which repo the event is for.
 */
export type WebhookParser = (
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
) => WebhookEvent;
