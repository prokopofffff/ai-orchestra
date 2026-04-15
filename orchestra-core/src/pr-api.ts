import { Router } from "express";
import { z } from "zod";
import { getPool } from "./db";
import { checkFilesScope, formatViolations } from "./scope-check";
import type { AgentRole } from "./config";
import { git } from "./repo-manager";
import { log } from "./obs";
import { providerForProject } from "./providers";

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
    if (!projRows[0].repo_url) return res.status(400).json({ error: "Project has no repository URL" });

    let provider;
    try {
      provider = await providerForProject(body.projectId);
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }

    // Push the branch to the remote from the agent's worktree.
    const { rows: sessionRows } = await pool.query(
      `SELECT worktree_path FROM sessions
       WHERE project_id = $1 AND status IN ('running', 'terminated')
       ORDER BY started_at DESC LIMIT 1`,
      [body.projectId],
    );

    if (sessionRows[0]?.worktree_path) {
      const cwd = sessionRows[0].worktree_path;

      // Scope validation: check all changed files against role permissions.
      const agentRole = (body.agentRole ?? req.headers["x-agent-role"]) as string | undefined;
      if (agentRole && agentRole !== "tech-lead") {
        try {
          const diff = await git(cwd).diff(["--name-only", "origin/main...HEAD"]);
          const files = diff.split("\n").filter(Boolean);
          const violations = checkFilesScope(agentRole as AgentRole, files);
          if (violations.length > 0) {
            return res.status(403).json({
              error: "Scope violation: PR contains out-of-scope files",
              violations: formatViolations(agentRole as AgentRole, violations),
            });
          }
        } catch { /* no origin/main → skip scope check */ }
      }

      try {
        const authUrl = provider.tokenizeCloneUrl();
        const g = git(cwd);
        try { await g.remote(["set-url", "origin", authUrl]); }
        catch { await g.remote(["add", "origin", authUrl]); }
        await g.push(["-u", "origin", body.head, "--force"]);
      } catch (err) {
        log.error({ err, head: body.head, provider: provider.kind }, "git push failed");
      }
    }

    try {
      const pr = await provider.createPR({
        title: body.title,
        body: body.body,
        head: body.head,
        base: body.base,
      });

      // Update task with PR URL if we can find the associated task.
      if (body.agentRole) {
        await pool.query(
          `UPDATE tasks SET pr_url = $1, updated_at = now()
           WHERE project_id = $2 AND assignee_role = $3
             AND state IN ('in_development', 'pr_created') AND pr_url IS NULL`,
          [pr.url, body.projectId, body.agentRole],
        ).catch(() => { /* best effort */ });
      }

      res.status(201).json({ url: pr.url, number: pr.number });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Providers prefix errors with "GitHub 422: ..." / "GitLab 400: ...";
      // pull the status out when present, default to 502 otherwise.
      const statusMatch = msg.match(/\b(4\d\d|5\d\d)\b/);
      const status = statusMatch ? Number(statusMatch[1]) : 502;
      return res.status(status).json({ error: msg });
    }
  } catch (e) { next(e); }
});

// ─── Get PR diff ───

prRouter.post("/pr/diff", async (req, res, next) => {
  try {
    const { prUrl, projectId } = req.body as { prUrl?: string; projectId?: string };
    if (!prUrl || !projectId) return res.status(400).json({ error: "prUrl and projectId required" });

    const provider = await providerForProject(projectId);
    const diff = await provider.getPRDiff(prUrl);
    res.json({ diff });
  } catch (e) { next(e); }
});

// ─── Submit PR review ───

prRouter.post("/pr/review", async (req, res, next) => {
  try {
    const body = req.body as {
      projectId?: string;
      prUrl?: string;
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body: string;
      comments?: Array<{ path: string; line: number; body: string }>;
    };
    if (!body.projectId || !body.prUrl) return res.status(400).json({ error: "projectId and prUrl required" });

    const provider = await providerForProject(body.projectId);
    const result = await provider.submitReview({
      prUrl: body.prUrl,
      event: body.event,
      body: body.body,
      comments: body.comments,
    });
    res.json(result);
  } catch (e) { next(e); }
});

// ─── Get PR reviews/comments ───

prRouter.post("/pr/reviews", async (req, res, next) => {
  try {
    const { prUrl, projectId } = req.body as { prUrl?: string; projectId?: string };
    if (!prUrl || !projectId) return res.status(400).json({ error: "prUrl and projectId required" });

    const provider = await providerForProject(projectId);
    const payload = await provider.getReviews(prUrl);
    res.json(payload);
  } catch (e) { next(e); }
});
