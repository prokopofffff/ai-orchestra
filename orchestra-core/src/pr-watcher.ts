import { z } from "zod";
import { getPool } from "./db";
import { notify } from "./notification-hub";
import { appendLog } from "./logger";
import { loadConfig } from "./config";
import { registerHandler, registerCron, enqueue } from "./scheduler";
import { log } from "./obs";
import { providerForProject } from "./providers";

const PR_DISCOVER_KIND = "pr-watcher:discover";
const PR_CHECK_ONE_KIND = "pr-watcher:check-one";

const CheckOnePayload = z.object({
  taskId: z.string(),
  projectId: z.string(),
  prUrl: z.string(),
  title: z.string(),
  state: z.string(),
});

/**
 * Can we resolve a git provider for this project? (Token present, repo URL
 * recognized.) Avoids queueing check-one jobs that would 401 or fail
 * discovery. Per-project — different projects can target GitHub or GitLab.
 */
async function canResolveProvider(projectId: string): Promise<boolean> {
  try {
    await providerForProject(projectId);
    return true;
  } catch {
    return false;
  }
}

// Discovery: cheap DB scan, no upstream API calls — no bucket needed.
registerHandler(PR_DISCOVER_KIND, z.object({}), async () => {
  const pool = getPool();
  const { rows: tasks } = await pool.query(
    `SELECT t.id, t.title, t.pr_url, t.state, t.project_id
     FROM tasks t
     WHERE t.pr_url IS NOT NULL
       AND t.state NOT IN ('merged', 'closed')`,
  );

  for (const t of tasks) {
    if (!(await canResolveProvider(t.project_id))) continue;

    // Skip if a check is already queued/running for this task — prevents
    // pile-up when the provider is slow or when discovery fires faster
    // than checks drain.
    const existing = await pool.query(
      `SELECT 1 FROM graphile_worker._private_jobs j
       JOIN graphile_worker._private_tasks t2 ON t2.id = j.task_id
       WHERE t2.identifier = $1
         AND j.payload->>'taskId' = $2
       LIMIT 1`,
      [PR_CHECK_ONE_KIND, t.id],
    );
    if (existing.rows.length) continue;

    await enqueue({
      kind: PR_CHECK_ONE_KIND,
      // Shared bucket across providers for now — capacity tuned for GitHub's
      // 5000/hr limit, which is conservative for most GitLab accounts too.
      bucketKey: "github:rest",
      payload: {
        taskId: t.id,
        projectId: t.project_id,
        prUrl: t.pr_url,
        title: t.title,
        state: t.state,
      },
    });
  }
});

// Per-PR check: one upstream call (two for the 'tested' branch's QA PR).
// Bucket-debited at claim time. Idempotent: re-checks current state from DB.
registerHandler(PR_CHECK_ONE_KIND, CheckOnePayload, async (p, ctx) => {
  const pool = getPool();
  const { rows: cur } = await pool.query(
    `SELECT state FROM tasks WHERE id = $1`, [p.taskId],
  );
  const currentState = cur[0]?.state as string | undefined;
  if (!currentState || ["merged", "closed", "in_testing"].includes(currentState)) return;

  let provider;
  try {
    provider = await providerForProject(p.projectId);
  } catch (err) {
    log.warn({ err, projectId: p.projectId }, "pr-watcher: provider unresolved, skipping");
    return;
  }

  const pr = await provider.getPR(p.prUrl).catch(() => null);
  if (!pr?.merged) return;

  if (currentState === "tested") {
    await ctx.extendLease(); // second upstream call coming
    const qaPrs = await provider.listPRs({ state: "all", headBranchPrefix: "test/" }).catch(() => []);
    const qaMerged = qaPrs.some((q) => q.merged);
    if (!qaMerged) return;

    await pool.query(
      "UPDATE tasks SET state = 'merged', revisions_count = 0, updated_at = now() WHERE id = $1",
      [p.taskId],
    );
    appendLog(p.projectId, null, "system", "system", `Task "${p.title}" → merged (code + tests PRs merged)`);
    await notify({ projectId: p.projectId, text: `Task complete: ${p.title}`, priority: "normal", fromRole: "system" });

    const { checkUnblocked } = await import("./dependency-engine");
    const unblocked = await checkUnblocked(p.taskId, p.projectId);
    if (unblocked.length) {
      appendLog(p.projectId, null, "system", "system", `"${p.title}" unblocked ${unblocked.length} task(s)`);
    }
    return;
  }

  if (["pr_created", "approved", "in_review"].includes(currentState)) {
    await pool.query("UPDATE tasks SET state = 'in_testing', updated_at = now() WHERE id = $1", [p.taskId]);
    appendLog(p.projectId, null, "system", "system", `PR merged: ${p.title} → dispatching QA`);
    await notify({ projectId: p.projectId, text: `PR merged: ${p.title} — QA testing started`, priority: "normal", fromRole: "system" });

    const config = loadConfig();
    const { enqueue: enqueueAgent } = await import("./rate-limiter");
    await enqueueAgent({ projectId: p.projectId, taskId: p.taskId, role: "qa", config });
  }
});

export async function startPrWatcher(): Promise<void> {
  // We register the cron unconditionally. Per-project provider resolution at
  // job time lets a single deploy service github-only, gitlab-only, or mixed
  // portfolios (as long as each project has its own token in settings or the
  // right global env var is present).
  await registerCron({
    key: "pr-watcher",
    kind: PR_DISCOVER_KIND,
    intervalSeconds: 60,
  });
  log.info("pr-watcher scheduled (discovery 60s, per-PR jobs bucketed on github:rest)");
}

export function stopPrWatcher(): void {}
