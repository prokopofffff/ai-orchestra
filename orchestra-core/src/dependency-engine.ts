import { getPool } from "./db.js";
import { logAudit } from "./flow-guard.js";

/**
 * Check if a task state change unblocks other tasks.
 * Called after task transitions to 'merged' or 'closed'.
 */
export async function checkUnblocked(taskId: string, projectId: string): Promise<string[]> {
  const pool = getPool();

  // Find tasks that have this task in their blocked_by
  const { rows: dependents } = await pool.query(
    `SELECT id, title, blocked_by FROM tasks
     WHERE project_id = $1 AND $2 = ANY(blocked_by)
     AND state NOT IN ('merged', 'closed')`,
    [projectId, taskId],
  );

  const unblockedTaskIds: string[] = [];

  for (const dep of dependents) {
    const blockedBy = dep.blocked_by as string[];

    // Check if ALL blockers are now done
    if (blockedBy.length > 0) {
      const { rows: remaining } = await pool.query(
        `SELECT id FROM tasks
         WHERE id = ANY($1) AND state NOT IN ('merged', 'closed')`,
        [blockedBy],
      );

      if (remaining.length === 0) {
        // All blockers done — this task is unblocked
        unblockedTaskIds.push(dep.id);

        // Emit task_unblocked signal to Tech Lead
        await pool.query(
          `INSERT INTO signals (project_id, task_id, from_role, to_role, action, payload)
           VALUES ($1, $2, 'system', 'tech-lead', 'task_unblocked', $3)`,
          [projectId, dep.id, JSON.stringify({ message: `Task "${dep.title}" is now unblocked` })],
        );

        await logAudit(
          { from: "system", to: "tech-lead", action: "task_unblocked", projectId, taskId: dep.id },
          "allowed",
        );
      }
    }
  }

  return unblockedTaskIds;
}

/**
 * Check if a task is currently blocked.
 * Returns list of blocking task IDs that are not yet done.
 */
export async function getBlockers(taskId: string): Promise<Array<{ id: string; title: string; state: string }>> {
  const pool = getPool();

  const { rows: taskRows } = await pool.query("SELECT blocked_by FROM tasks WHERE id = $1", [taskId]);
  if (!taskRows.length) return [];

  const blockedBy = taskRows[0].blocked_by as string[];
  if (!blockedBy.length) return [];

  const { rows } = await pool.query(
    `SELECT id, title, state FROM tasks
     WHERE id = ANY($1) AND state NOT IN ('merged', 'closed')`,
    [blockedBy],
  );

  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    state: r.state as string,
  }));
}

/**
 * Validate that adding a dependency doesn't create a cycle.
 */
export async function wouldCreateCycle(taskId: string, blockerId: string): Promise<boolean> {
  if (taskId === blockerId) return true;

  const pool = getPool();
  const visited = new Set<string>();
  const queue = [blockerId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const { rows } = await pool.query("SELECT blocked_by FROM tasks WHERE id = $1", [current]);
    if (!rows.length) continue;

    const deps = rows[0].blocked_by as string[];
    for (const dep of deps) {
      if (dep === taskId) return true; // Cycle detected
      queue.push(dep);
    }
  }

  return false;
}
