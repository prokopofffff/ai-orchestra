import { z } from "zod";
import { getPool } from "./db";
import { registerHandler, registerCron } from "./scheduler";
import { resolveTaskHourlyCostUsd } from "./limits";
import { escalate } from "./notification-hub";
import { log } from "./obs";

/**
 * Periodic anomaly detector. The static daily cap (M1.1) catches sustained
 * overspend, but doesn't notice a task burning through $4 in 20 minutes — the
 * project total stays under cap until it suddenly explodes. This watcher
 * pulls the last hour of spend per task; anything above
 * settings.limits.taskHourlyCostUsd freezes the task and escalates.
 *
 * Scoped per-task because cap-on-task is the actionable unit (we can freeze
 * one task without affecting the rest of the project).
 */
const VELOCITY_KIND = "cost-velocity-watcher:scan";

registerHandler(VELOCITY_KIND, z.object({}), async () => {
  await scanCostVelocity();
});

export async function startCostVelocityWatcher(): Promise<void> {
  await registerCron({
    key: "cost-velocity-watcher",
    kind: VELOCITY_KIND,
    intervalSeconds: 5 * 60,
  });
  log.info("cost-velocity-watcher scheduled (every 5min)");
}

export function stopCostVelocityWatcher(): void {}

export async function scanCostVelocity(): Promise<{ frozen: number }> {
  const pool = getPool();

  // Per-task spend in the last hour. Filter at the DB so we don't pull all
  // rows back. Skip tasks that are already frozen.
  const { rows } = await pool.query(
    `SELECT u.task_id, u.project_id, p.settings,
            COALESCE(SUM(u.cost_usd), 0)::float8 AS total
       FROM usage_costs u
       JOIN tasks t ON t.id = u.task_id
       JOIN projects p ON p.id = u.project_id
      WHERE u.task_id IS NOT NULL
        AND u.created_at >= now() - interval '1 hour'
        AND t.frozen_reason IS NULL
      GROUP BY u.task_id, u.project_id, p.settings`,
  );

  let frozen = 0;
  for (const r of rows as Array<{ task_id: string; project_id: string; settings: unknown; total: number }>) {
    const cap = resolveTaskHourlyCostUsd(r.settings);
    if (cap <= 0 || r.total < cap) continue;

    const reason = `Cost velocity ${r.total.toFixed(2)}/h > $${cap.toFixed(2)}/h — frozen for review`;
    const result = await pool.query(
      `UPDATE tasks SET frozen_reason = COALESCE(frozen_reason, $1), updated_at = now()
        WHERE id = $2 AND frozen_reason IS NULL`,
      [reason, r.task_id],
    );
    if (result.rowCount && result.rowCount > 0) {
      await escalate(r.project_id, r.task_id, reason, {
        event: "cost_velocity",
        spentLastHourUsd: r.total,
        capUsd: cap,
      });
      frozen += 1;
    }
  }
  log.debug({ frozen, scanned: rows.length }, "cost-velocity scan complete");
  return { frozen };
}
