import { getPool } from "./db.js";
import { notify } from "./notification-hub.js";
import { appendLog } from "./logger.js";
import { loadConfig } from "./config.js";

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

    // tested + merged → auto-advance to merged
    if (currentState === "tested") {
      await pool.query("UPDATE tasks SET state = 'merged', updated_at = now() WHERE id = $1", [taskId]);
      appendLog(projectId, null, "system", "system", `Task "${title}" → merged (QA passed + PR merged)`);
      await notify({ projectId, text: `Task complete: ${title}`, priority: "normal", fromRole: "system" });

      const { checkUnblocked } = await import("./dependency-engine.js");
      const unblocked = await checkUnblocked(taskId, projectId);
      if (unblocked.length) {
        appendLog(projectId, null, "system", "system", `"${title}" unblocked ${unblocked.length} task(s)`);
      }
      console.log(`Task "${title}" → merged (tested + PR merged)`);
      continue;
    }

    // approved/pr_created + merged → dispatch QA
    if (["pr_created", "approved", "in_review"].includes(currentState)) {
      await pool.query("UPDATE tasks SET state = 'in_testing', updated_at = now() WHERE id = $1", [taskId]);
      appendLog(projectId, null, "system", "system", `PR merged: ${title} → dispatching QA`);
      await notify({ projectId, text: `PR merged: ${title} — QA testing started`, priority: "normal", fromRole: "system" });

      const config = loadConfig();
      const { enqueue } = await import("./rate-limiter.js");
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
