import { Router } from "express";
import { z } from "zod";
import { getPool } from "./db.js";

export const prRouter: Router = Router();

prRouter.post("/pr/create", async (req, res, next) => {
  try {
    const body = z.object({
      projectId: z.string().uuid(),
      title: z.string(),
      body: z.string(),
      head: z.string(),
      base: z.string().default("main"),
      agentRole: z.string().optional(),
    }).parse(req.body);

    const pool = getPool();
    const { rows: projRows } = await pool.query(
      "SELECT repo_url FROM projects WHERE id = $1",
      [body.projectId],
    );

    if (!projRows.length) return res.status(404).json({ error: "Project not found" });
    const repoUrl = projRows[0].repo_url as string | null;

    if (!repoUrl) return res.status(400).json({ error: "Project has no repository URL" });

    const token = process.env.GITHUB_TOKEN;
    if (!token) return res.status(400).json({ error: "GITHUB_TOKEN not configured" });

    // Parse owner/repo from URL
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (!match) return res.status(400).json({ error: `Cannot parse GitHub owner/repo from: ${repoUrl}` });

    const [, owner, repo] = match;

    // Push branch to remote first (from the worktree)
    const { rows: sessionRows } = await pool.query(
      `SELECT worktree_path FROM sessions
       WHERE project_id = $1 AND status IN ('running', 'terminated')
       ORDER BY started_at DESC LIMIT 1`,
      [body.projectId],
    );

    if (sessionRows[0]?.worktree_path) {
      const { execSync } = await import("node:child_process");
      const cwd = sessionRows[0].worktree_path;
      try {
        // Set remote URL with token
        const authUrl = `https://${token}@github.com/${owner}/${repo}.git`;
        execSync(`git remote set-url origin "${authUrl}" 2>/dev/null || git remote add origin "${authUrl}"`, { cwd, stdio: "pipe" });
        execSync(`git push -u origin "${body.head}" --force`, { cwd, stdio: "pipe" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Git push failed:", msg);
        // Continue anyway — branch might already be pushed
      }
    }

    // Create PR via GitHub API
    const apiRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: body.title,
        body: body.body,
        head: body.head,
        base: body.base,
      }),
    });

    const data = await apiRes.json() as Record<string, unknown>;

    if (!apiRes.ok) {
      return res.status(apiRes.status).json({
        error: (data.message as string) ?? "GitHub API error",
        details: data.errors,
      });
    }

    const prUrl = data.html_url as string;

    // Update task with PR URL if we can find the associated task
    if (body.agentRole) {
      await pool.query(
        `UPDATE tasks SET pr_url = $1, updated_at = now()
         WHERE project_id = $2 AND assignee_role = $3 AND state IN ('in_development', 'pr_created')
         AND pr_url IS NULL
         LIMIT 1`,
        [prUrl, body.projectId, body.agentRole],
      ).catch(() => { /* best effort */ });
    }

    res.status(201).json({ url: prUrl, number: data.number });
  } catch (e) { next(e); }
});

// ─── Helper: parse PR URL → owner/repo/number ───

function parsePrUrl(prUrl: string): { owner: string; repo: string; number: string } | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

function getToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not configured");
  return token;
}

// ─── Get PR diff ───

prRouter.post("/pr/diff", async (req, res, next) => {
  try {
    const { prUrl } = req.body as { prUrl: string };
    const pr = parsePrUrl(prUrl);
    if (!pr) return res.status(400).json({ error: "Invalid PR URL" });

    const token = getToken();
    const apiRes = await fetch(
      `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.diff",
        },
      },
    );

    if (!apiRes.ok) return res.status(apiRes.status).json({ error: "Failed to fetch diff" });

    const diff = await apiRes.text();
    res.json({ diff });
  } catch (e) { next(e); }
});

// ─── Submit PR review ───

prRouter.post("/pr/review", async (req, res, next) => {
  try {
    const body = req.body as {
      prUrl: string;
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body: string;
      comments?: Array<{ path: string; line: number; body: string }>;
    };

    const pr = parsePrUrl(body.prUrl);
    if (!pr) return res.status(400).json({ error: "Invalid PR URL" });

    const token = getToken();

    // Get the latest commit SHA (required for review comments)
    const prRes = await fetch(
      `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
    );
    const prData = await prRes.json() as { head: { sha: string } };

    const reviewBody: Record<string, unknown> = {
      body: body.body,
      event: body.event,
      commit_id: prData.head.sha,
    };

    if (body.comments?.length) {
      reviewBody.comments = body.comments.map((c) => ({
        path: c.path,
        line: c.line,
        body: c.body,
      }));
    }

    const apiRes = await fetch(
      `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(reviewBody),
      },
    );

    const data = await apiRes.json() as Record<string, unknown>;

    if (!apiRes.ok) {
      return res.status(apiRes.status).json({
        error: (data.message as string) ?? "GitHub API error",
        details: data,
      });
    }

    res.json({ id: data.id, state: data.state });
  } catch (e) { next(e); }
});

// ─── Get PR reviews/comments ───

prRouter.post("/pr/reviews", async (req, res, next) => {
  try {
    const { prUrl } = req.body as { prUrl: string };
    const pr = parsePrUrl(prUrl);
    if (!pr) return res.status(400).json({ error: "Invalid PR URL" });

    const token = getToken();

    // Get review comments (inline)
    const commentsRes = await fetch(
      `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
    );
    const comments = await commentsRes.json() as Array<Record<string, unknown>>;

    // Get reviews (top-level)
    const reviewsRes = await fetch(
      `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
    );
    const reviews = await reviewsRes.json() as Array<Record<string, unknown>>;

    const formatted = {
      reviews: reviews.map((r) => ({
        state: r.state,
        body: r.body,
        user: (r.user as Record<string, unknown>)?.login,
        submittedAt: r.submitted_at,
      })),
      comments: comments.map((c) => ({
        path: c.path,
        line: c.line ?? c.original_line,
        body: c.body,
        user: (c.user as Record<string, unknown>)?.login,
        createdAt: c.created_at,
      })),
    };

    res.json(formatted);
  } catch (e) { next(e); }
});
