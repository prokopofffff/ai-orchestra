import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getPool } from "./db";
import { checkFilesScope, formatViolations } from "./scope-check";
import type { AgentRole } from "./config";
import { git } from "./repo-manager";
import { log } from "./obs";
import { providerForProject } from "./providers";
import { currentUserId } from "./auth";
import { userCanAccessProject, userCanEditProject } from "./project-access";

export const prPlugin: FastifyPluginAsync = async (app) => {
  app.post("/pr/create", async (request, reply) => {
    const body = z.object({
      projectId: z.string().uuid(),
      title: z.string(),
      body: z.string(),
      head: z.string(),
      base: z.string().default("main"),
      agentRole: z.string().optional(),
    }).parse(request.body);

    // Multi-tenant gate: caller must have edit rights on the project they
    // claim to be creating a PR for. Without this an authenticated user
    // from any tenant could trigger pushes + PR creation in any other
    // tenant's project just by passing a different projectId.
    const userId = currentUserId(request);
    if (!(await userCanEditProject(userId, body.projectId))) {
      return reply.code(404).send({ error: "Проект не найден" });
    }

    const pool = getPool();
    const { rows: projRows } = await pool.query(
      "SELECT repo_url FROM projects WHERE id = $1",
      [body.projectId],
    );
    if (!projRows.length) return reply.code(404).send({ error: "Проект не найден" });
    if (!projRows[0].repo_url) return reply.code(400).send({ error: "У проекта не указан URL репозитория" });

    let provider;
    try {
      provider = await providerForProject(body.projectId);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
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
      const agentRole = (body.agentRole ?? request.headers["x-agent-role"]) as string | undefined;
      if (agentRole && agentRole !== "tech-lead") {
        try {
          const diff = await git(cwd).diff(["--name-only", "origin/main...HEAD"]);
          const files = diff.split("\n").filter(Boolean);
          const violations = checkFilesScope(agentRole as AgentRole, files);
          if (violations.length > 0) {
            return reply.code(403).send({
              error: "Нарушение области ответственности: PR содержит файлы вне зоны ответственности агента",
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

      // Update task with PR URL + the source branch the PR was raised
      // from. branch_name is what `createWorktree` reads to base later
      // worktrees off the dev's actual work (see agent-spawner.ts) —
      // without it, QA spawned for testing this PR would still read
      // origin/main and report "files missing" on a perfectly valid PR.
      if (body.agentRole) {
        await pool.query(
          `UPDATE tasks SET pr_url = $1, branch_name = $2, updated_at = now()
           WHERE project_id = $3 AND assignee_role = $4
             AND state IN ('in_development', 'pr_created') AND pr_url IS NULL`,
          [pr.url, body.head, body.projectId, body.agentRole],
        ).catch(() => { /* best effort */ });
      }

      return reply.code(201).send({ url: pr.url, number: pr.number });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Providers prefix errors with "GitHub 422: ..." / "GitLab 400: ...";
      // pull the status out when present, default to 502 otherwise.
      const statusMatch = msg.match(/\b(4\d\d|5\d\d)\b/);
      const status = statusMatch ? Number(statusMatch[1]) : 502;
      return reply.code(status).send({ error: msg });
    }
  });

  // ─── Get PR diff ───
  //
  // Read-level access: anyone who can see the project can fetch the diff
  // of one of its PRs. Without the gate, any authenticated user could
  // pull diffs from any tenant by supplying their projectId.

  app.post("/pr/diff", async (request, reply) => {
    const body = z.object({
      projectId: z.string().uuid(),
      prUrl: z.string().url(),
    }).parse(request.body);

    const userId = currentUserId(request);
    if (!(await userCanAccessProject(userId, body.projectId))) {
      return reply.code(404).send({ error: "Проект не найден" });
    }

    const provider = await providerForProject(body.projectId);
    const diff = await provider.getPRDiff(body.prUrl);
    return { diff };
  });

  // ─── Submit PR review ───
  //
  // Edit-level access: submitting an approve/request-changes/comment
  // writes to the upstream provider, so the caller must be allowed to
  // edit the project (not merely view it).

  app.post("/pr/review", async (request, reply) => {
    const body = z.object({
      projectId: z.string().uuid(),
      prUrl: z.string().url(),
      event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
      body: z.string(),
      comments: z.array(z.object({
        path: z.string(),
        line: z.number(),
        body: z.string(),
      })).optional(),
    }).parse(request.body);

    const userId = currentUserId(request);
    if (!(await userCanEditProject(userId, body.projectId))) {
      return reply.code(404).send({ error: "Проект не найден" });
    }

    const provider = await providerForProject(body.projectId);
    const result = await provider.submitReview({
      prUrl: body.prUrl,
      event: body.event,
      body: body.body,
      comments: body.comments,
    });
    return result;
  });

  // ─── Get PR reviews/comments ───

  app.post("/pr/reviews", async (request, reply) => {
    const body = z.object({
      projectId: z.string().uuid(),
      prUrl: z.string().url(),
    }).parse(request.body);

    const userId = currentUserId(request);
    if (!(await userCanAccessProject(userId, body.projectId))) {
      return reply.code(404).send({ error: "Проект не найден" });
    }

    const provider = await providerForProject(body.projectId);
    const payload = await provider.getReviews(body.prUrl);
    return payload;
  });
};
