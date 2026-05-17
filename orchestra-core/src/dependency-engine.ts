import { getPool } from "./db";
import { logAudit } from "./flow-guard";

/**
 * Task states that count as "done enough to unblock dependents."
 *
 * NOT included: `approved`, `tested`. Both mark PR quality milestones
 * (TL approved the PR / QA's tests pass) but the code is NOT in `main`
 * yet — the PR is waiting on a human (or auto-merge) to merge. A
 * downstream task that starts at this point checks out an empty `main`
 * and tries to build against nothing. We saw exactly that: TL approved
 * the design task, signaled `design_ready` to frontend, frontend
 * started, no design system existed in main.
 *
 * Included:
 *   - `merged`  — PR merged into main, code is live.
 *   - `closed`  — task abandoned / won't-fix; dependents shouldn't wait.
 *   - `design_ready` — designer's done-marker (design files in repo
 *     OR design system extracted; treated as available).
 */
export const DONE_STATES = ["merged", "closed", "design_ready"] as const;

/** SQL-safe list for use inside `state NOT IN (…)` clauses. */
const DONE_STATES_SQL = DONE_STATES.map((s) => `'${s}'`).join(", ");

/**
 * Check if a task state change unblocks other tasks.
 * Called after task transitions to a DONE_STATES value.
 */
export async function checkUnblocked(taskId: string, projectId: string): Promise<string[]> {
  const pool = getPool();

  // Find tasks that have this task in their blocked_by
  const { rows: dependents } = await pool.query(
    `SELECT id, title, blocked_by FROM tasks
     WHERE project_id = $1 AND $2 = ANY(blocked_by)
     AND state NOT IN (${DONE_STATES_SQL})`,
    [projectId, taskId],
  );

  const unblockedTaskIds: string[] = [];

  for (const dep of dependents) {
    const blockedBy = dep.blocked_by as string[];

    // Check if ALL blockers are now done
    if (blockedBy.length > 0) {
      const { rows: remaining } = await pool.query(
        `SELECT id FROM tasks
         WHERE id = ANY($1) AND state NOT IN (${DONE_STATES_SQL})`,
        [blockedBy],
      );

      if (remaining.length === 0) {
        // All blockers done — clear blocked_by array and unblock
        unblockedTaskIds.push(dep.id);
        await pool.query(
          "UPDATE tasks SET blocked_by = '{}', updated_at = now() WHERE id = $1",
          [dep.id],
        );

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
     WHERE id = ANY($1) AND state NOT IN (${DONE_STATES_SQL})`,
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
