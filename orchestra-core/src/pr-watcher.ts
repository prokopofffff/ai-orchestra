import { z } from "zod";
import { getPool } from "./db";
import { notify } from "./notification-hub";
import { appendLog } from "./logger";
import { loadConfig } from "./config";
import { registerHandler, registerCron, enqueue } from "./scheduler";
import { log } from "./obs";

const PR_DISCOVER_KIND = "pr-watcher:discover";
const PR_CHECK_ONE_KIND = "pr-watcher:check-one";

const CheckOnePayload = z.object({
  taskId: z.string(),
  projectId: z.string(),
  prUrl: z.string(),
  title: z.string(),
  state: z.string(),
});

// Discovery: cheap DB scan, no GitHub calls — no bucket needed.
registerHandler(PR_DISCOVER_KIND, z.object({}), async () => {
  if (!process.env.GITHUB_TOKEN) return;
  const pool = getPool();
  const { rows: tasks } = await pool.query(
    `SELECT t.id, t.title, t.pr_url, t.state, t.project_id
     FROM tasks t
     WHERE t.pr_url IS NOT NULL
       AND t.state NOT IN ('merged', 'closed')`,
  );

  for (const t of tasks) {
    // Skip if a check is already queued/running for this task — prevents pile-up
    // when GitHub is slow or when discovery fires faster than checks drain.
    // graphile-worker holds the queue in its own schema.
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

// Per-PR check: one GitHub call (sometimes two for the 'tested' branch).
// Bucket-debited at claim time. Idempotent: re-checks current state from DB.
registerHandler(PR_CHECK_ONE_KIND, CheckOnePayload, async (p, ctx) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;

  const pool = getPool();
  const { rows: cur } = await pool.query(
    `SELECT state FROM tasks WHERE id = $1`, [p.taskId],
  );
  const currentState = cur[0]?.state as string | undefined;
  if (!currentState || ["merged", "closed", "in_testing"].includes(currentState)) return;

  const merged = await isPrMerged(p.prUrl, token);
  if (!merged) return;

  if (currentState === "tested") {
    const pr = parsePrUrl(p.prUrl);
    if (pr) {
      await ctx.extendLease(); // 2nd GitHub call coming
      const qaPrs = await fetch(
        `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls?state=all&per_page=10`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
      ).then(r => r.json()) as Array<{ head: { ref: string }; merged: boolean }>;

      const qaPr = qaPrs.find(pr => pr.head.ref.startsWith("test/") && pr.merged);
      if (!qaPr) return;
    }

    await pool.query("UPDATE tasks SET state = 'merged', updated_at = now() WHERE id = $1", [p.taskId]);
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
  if (!process.env.GITHUB_TOKEN) return;
  await registerCron({
    key: "pr-watcher",
    kind: PR_DISCOVER_KIND,
    intervalSeconds: 60,
  });
  log.info("pr-watcher scheduled (discovery 60s, per-PR jobs bucketed on github:rest)");
}

export function stopPrWatcher(): void {}

function parsePrUrl(prUrl: string): { owner: string; repo: string; number: string } | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

async function isPrMerged(prUrl: string, token: string): Promise<boolean> {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return false;
  const [, owner, repo, number] = match;
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return false;
    const data = await res.json() as { merged: boolean; state: string };
    return data.merged === true;
  } catch {
    return false;
  }
}
