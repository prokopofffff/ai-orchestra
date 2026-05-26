import { z } from "zod";
import { registerHandler, registerCron } from "./scheduler";
import { getPool } from "./db";
import { notify } from "./notification-hub";
import { log } from "./obs";

/**
 * Defense-in-depth against agent-stuck loops.
 *
 * The reconciler will happily respawn a task forever as long as it stays
 * in an active state with no running session. Several bug shapes (invalid
 * state from a buggy MCP tool, mismatched role × allowedStateChanges,
 * runtime crashes that leave no completion signal) end up looking the
 * same to the reconciler: "active state, no session, please spawn".
 *
 * This watchdog catches the *shape* without needing to know which root
 * cause is in play. If a task has been in an active state for longer
 * than the watchdog window AND no session has been started for it in
 * that window, freeze it with a descriptive reason. The user gets ONE
 * Telegram message (frozen_reason is set with `WHERE frozen_reason IS NULL`,
 * so concurrent runs can't double-notify). After that the reconciler skips
 * it and the user resolves manually via Unfreeze in the dashboard.
 */

const WATCHDOG_KIND = "stuck-watchdog:scan";
const WATCHDOG_WINDOW_MINUTES = 30;

const ACTIVE_STATES = [
  "designing", "in_development", "in_testing", "in_review", "pr_created",
];

registerHandler(WATCHDOG_KIND, z.object({}), async () => {
  try {
    await freezeStuckTasks();
  } catch (err) {
    log.warn({ err }, "stuck-watchdog: scan failed");
  }
});

async function freezeStuckTasks(): Promise<void> {
  const pool = getPool();

  // Candidates: active state, not frozen, no running session, no session
  // started in the last WINDOW. updated_at < cutoff guards against freezing
  // a task that was just moved to an active state by a signal but hasn't
  // had time to spawn yet.
  const { rows } = await pool.query(
    `SELECT t.id, t.project_id, t.title, t.state, t.assignee_role
       FROM tasks t
      WHERE t.state = ANY($1::text[])
        AND t.frozen_reason IS NULL
        AND t.updated_at < now() - ($2 || ' minutes')::interval
        AND NOT EXISTS (
          SELECT 1 FROM sessions s
           WHERE s.task_id = t.id
             AND (s.status = 'running' OR s.started_at > now() - ($2 || ' minutes')::interval)
        )`,
    [ACTIVE_STATES, String(WATCHDOG_WINDOW_MINUTES)],
  );

  if (rows.length === 0) return;

  for (const row of rows) {
    const reason =
      `Watchdog: задача застряла в состоянии "${row.state}" более ${WATCHDOG_WINDOW_MINUTES} минут без прогресса. ` +
      `Разморозьте в настройках задачи после устранения причины.`;
    const { rows: updated } = await pool.query(
      `UPDATE tasks
          SET frozen_reason = $1, updated_at = now()
        WHERE id = $2 AND frozen_reason IS NULL
        RETURNING id`,
      [reason, row.id],
    );
    if (updated.length === 0) continue;

    log.warn(
      { taskId: row.id, projectId: row.project_id, state: row.state, role: row.assignee_role },
      "stuck-watchdog: froze stalled task",
    );
    await notify({
      projectId: row.project_id,
      text: `⚠ Задача "${row.title}" заморожена watchdog\'ом (${row.state}, ${WATCHDOG_WINDOW_MINUTES}+ мин без прогресса)`,
      priority: "high",
      fromRole: "system",
      metadata: { event: "watchdog_freeze", taskId: row.id, state: row.state },
    }).catch((e) => log.warn({ err: e, taskId: row.id }, "stuck-watchdog: notify failed"));
  }
}

export async function startStuckWatchdog(): Promise<void> {
  // 5-minute cadence: fast enough to catch a loop within ~35 min, slow
  // enough that the COUNT of candidates stays small even on big projects.
  await registerCron({
    key: "stuck-watchdog",
    kind: WATCHDOG_KIND,
    intervalSeconds: 5 * 60,
  });
  log.info(`stuck-watchdog scheduled (every 5min, freeze threshold ${WATCHDOG_WINDOW_MINUTES}min)`);
}

export function stopStuckWatchdog(): void { /* cron-based, nothing to stop */ }
