import { getPool } from "./db";
import { providerFor } from "./providers";
import { notify } from "./notification-hub";
import { appendLog } from "./logger";
import { log } from "./obs";
import type { ProjectSettings } from "@ai-orchestra/shared";

/**
 * Attempt to auto-merge the PR attached to `taskId` when the project has
 * opted into auto-merge. No-op when:
 *
 *   - settings.autoMerge is not true
 *   - the task has no pr_url (signal arrived before PR creation, or PR
 *     already removed)
 *   - the project has no repo_url (local-path-only projects don't have
 *     a provider to call)
 *
 * On a soft refusal from the provider (merge conflict, branch protection,
 * required checks pending) we notify the user with the reason and leave
 * the PR open — they handle it via the provider UI. On a hard failure
 * (transport error, bad token) we log and notify too; the caller is
 * already running this in the background and shouldn't see the throw.
 *
 * We intentionally do NOT signal `pr_merged` back into the system on
 * success — the GitHub/GitLab webhook + pr-watcher already turns merged
 * PRs into `pr_merged` events, and going through the same path keeps the
 * downstream effects (QA dispatch, task state transition) in one place.
 */
export async function tryAutoMerge(projectId: string, taskId: string): Promise<void> {
  const { rows } = await getPool().query<{
    pr_url: string | null;
    repo_url: string | null;
    settings: ProjectSettings | null;
    title: string | null;
  }>(
    `SELECT t.pr_url, p.repo_url, p.settings, t.title
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
      WHERE t.id = $1 AND t.project_id = $2
      LIMIT 1`,
    [taskId, projectId],
  );
  const row = rows[0];
  if (!row) return;
  if (!row.settings?.autoMerge) return;
  if (!row.pr_url) {
    appendLog(projectId, null, "system", "system",
      `auto-merge skipped: task ${taskId} has no pr_url`);
    return;
  }
  if (!row.repo_url) {
    appendLog(projectId, null, "system", "system",
      `auto-merge skipped: project has no repo_url (local-path-only)`);
    return;
  }

  let provider;
  try {
    provider = providerFor(row.repo_url, row.settings);
  } catch (err) {
    log.error({ err, projectId, taskId }, "auto-merge: provider resolution failed");
    return;
  }

  try {
    const result = await provider.mergePR(row.pr_url, { method: "squash" });
    if (result.merged) {
      appendLog(projectId, null, "system", "system",
        `auto-merged PR ${row.pr_url} (sha ${result.sha.slice(0, 7)})`);
      await notify({
        projectId,
        text: `Auto-merged: ${row.title ?? row.pr_url}`,
        priority: "normal",
        fromRole: "system",
      });
      return;
    }
    // Soft refusal — leave PR open, ping the user with the reason.
    appendLog(projectId, null, "system", "system",
      `auto-merge declined for ${row.pr_url}: ${result.reason}`);
    await notify({
      projectId,
      text: `Auto-merge declined for "${row.title ?? row.pr_url}": ${result.reason}. PR left open — merge manually via the provider.`,
      priority: "high",
      fromRole: "system",
    });
  } catch (err) {
    log.error({ err, projectId, taskId, prUrl: row.pr_url }, "auto-merge: provider call failed");
    await notify({
      projectId,
      text: `Auto-merge failed for "${row.title ?? row.pr_url}": ${err instanceof Error ? err.message : String(err)}. PR left open.`,
      priority: "high",
      fromRole: "system",
    }).catch(() => { /* best-effort */ });
  }
}
