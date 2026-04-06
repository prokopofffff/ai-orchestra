import { getPool } from "./db";
import { notify } from "./notification-hub";
import { appendLog } from "./logger";
import { loadConfig } from "./config";

const CHECK_INTERVAL_MS = 60_000; // every minute
let intervalId: ReturnType<typeof setInterval> | null = null;

export function startPrWatcher(): void {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;

  intervalId = setInterval(() => checkMergedPrs(token), CHECK_INTERVAL_MS);
  console.log("PR watcher started (every 60s)");
}

export function stopPrWatcher(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

async function checkMergedPrs(token: string): Promise<void> {
  const pool = getPool();

  // Find tasks with PR URLs that are in approved/pr_created/in_review/in_testing/tested state
  const { rows: tasks } = await pool.query(
    `SELECT t.id, t.title, t.pr_url, t.state, t.project_id
     FROM tasks t
     WHERE t.pr_url IS NOT NULL
       AND t.state NOT IN ('merged', 'closed')`,
  );

  for (const task of tasks) {
    const prUrl = task.pr_url as string;
    const projectId = task.project_id as string;
    const taskId = task.id as string;
    const title = task.title as string;
    const currentState = task.state as string;

    const prMerged = await isPrMerged(prUrl, token);
    if (!prMerged) continue;

    // tested — check if QA test PR is also merged before advancing to merged
    if (currentState === "tested") {
      // Find QA test branch PR for this task
      const { rows: qaSessions } = await pool.query(
        `SELECT worktree_path FROM sessions WHERE task_id = $1 AND role = 'qa' ORDER BY started_at DESC LIMIT 1`,
        [taskId],
      );
      // Look for any open PRs from test branches
      const pr = parsePrUrl(prUrl);
      if (pr) {
        const qaPrs = await fetch(
          `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls?state=all&per_page=10`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
        ).then(r => r.json()) as Array<Record<string, unknown>>;

        const qaPr = (qaPrs as Array<{ head: { ref: string }; merged: boolean }>)
          .find(p => (p.head.ref as string).startsWith("test/") && p.merged);

        if (!qaPr) {
          // QA PR not merged yet — don't advance
          continue;
        }
      }

      await pool.query("UPDATE tasks SET state = 'merged', updated_at = now() WHERE id = $1", [taskId]);
      appendLog(projectId, null, "system", "system", `Task "${title}" → merged (code + tests PRs merged)`);
      await notify({ projectId, text: `Task complete: ${title}`, priority: "normal", fromRole: "system" });

      const { checkUnblocked } = await import("./dependency-engine");
      const unblocked = await checkUnblocked(taskId, projectId);
      if (unblocked.length) {
        appendLog(projectId, null, "system", "system", `"${title}" unblocked ${unblocked.length} task(s)`);
      }
      console.log(`Task "${title}" → merged (code + tests PRs merged)`);
      continue;
    }

    // approved/pr_created + merged → dispatch QA
    if (["pr_created", "approved", "in_review"].includes(currentState)) {
      await pool.query("UPDATE tasks SET state = 'in_testing', updated_at = now() WHERE id = $1", [taskId]);
      appendLog(projectId, null, "system", "system", `PR merged: ${title} → dispatching QA`);
      await notify({ projectId, text: `PR merged: ${title} — QA testing started`, priority: "normal", fromRole: "system" });

      const config = loadConfig();
      const { enqueue } = await import("./rate-limiter");
      await enqueue({ projectId, taskId, role: "qa", config });
      console.log(`PR merged: ${title} → in_testing → QA dispatched`);
      continue;
    }

    // Skip states that are already past testing
    if (["in_testing", "merged", "closed"].includes(currentState)) {
      continue;
    }

    // Fallback for any other merged state
    {
    }
  }
}

function parsePrUrl(prUrl: string): { owner: string; repo: string; number: string } | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

async function isPrMerged(prUrl: string, token: string): Promise<boolean> {
  // Parse owner/repo/number from PR URL
  // https://github.com/owner/repo/pull/123
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return false;

  const [, owner, repo, number] = match;

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!res.ok) return false;

    const data = await res.json() as { merged: boolean; state: string };
    return data.merged === true;
  } catch {
    return false;
  }
}
