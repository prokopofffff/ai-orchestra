import type { ModelUsage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRole } from "./config";
import { getPool } from "./db";
import { log } from "./obs";

export type RecordCostInput = {
  projectId: string;
  sessionId: string;
  taskId: string | null;
  role: AgentRole;
  result: SDKResultMessage;
};

/**
 * Persist per-model spend from a completed agent run. The SDK's `result` message
 * carries `modelUsage: Record<model, ModelUsage>` (sdk.d.ts:925) where each entry
 * already includes a computed `costUSD` — no client-side price table needed.
 *
 * Writes one row per model. If `modelUsage` is empty (rare error paths) we fall
 * back to a single row with `total_cost_usd` so the cap math doesn't lose runs.
 */
export async function recordCost(input: RecordCostInput): Promise<void> {
  const { projectId, sessionId, taskId, role, result } = input;
  const pool = getPool();
  const subtype = result.subtype;

  const entries = Object.entries(result.modelUsage ?? {});
  if (entries.length === 0) {
    // Defensive: keep cost visible even when modelUsage is missing.
    if ((result.total_cost_usd ?? 0) > 0) {
      await pool.query(
        `INSERT INTO usage_costs
           (project_id, session_id, task_id, role, model, cost_usd, duration_ms, result_subtype)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [projectId, sessionId, taskId, role, "unknown", result.total_cost_usd, result.duration_ms, subtype],
      );
    }
    return;
  }

  for (const [model, usage] of entries) {
    const u = usage as ModelUsage;
    await pool.query(
      `INSERT INTO usage_costs
         (project_id, session_id, task_id, role, model, cost_usd,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          duration_ms, result_subtype)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        projectId, sessionId, taskId, role, model, u.costUSD ?? 0,
        u.inputTokens ?? 0, u.outputTokens ?? 0,
        u.cacheReadInputTokens ?? 0, u.cacheCreationInputTokens ?? 0,
        result.duration_ms, subtype,
      ],
    );
  }
}

/**
 * Total USD spent on a project within the last 24h ending now.
 * The pre-spawn gate (M1.1) reads this before each agent launch.
 */
export async function getDailyCost(projectId: string): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
       FROM usage_costs
      WHERE project_id = $1
        AND created_at >= now() - interval '1 day'`,
    [projectId],
  );
  return rows[0]?.total ?? 0;
}

export type DailyCostBreakdown = {
  total: number;
  byRole: Record<string, number>;
  byModel: Record<string, number>;
};

export async function getDailyCostBreakdown(projectId: string): Promise<DailyCostBreakdown> {
  const pool = getPool();
  const [{ rows: totalRows }, { rows: roleRows }, { rows: modelRows }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
         FROM usage_costs
        WHERE project_id = $1 AND created_at >= now() - interval '1 day'`,
      [projectId],
    ),
    pool.query(
      `SELECT role, COALESCE(SUM(cost_usd), 0)::float8 AS total
         FROM usage_costs
        WHERE project_id = $1 AND created_at >= now() - interval '1 day'
        GROUP BY role`,
      [projectId],
    ),
    pool.query(
      `SELECT model, COALESCE(SUM(cost_usd), 0)::float8 AS total
         FROM usage_costs
        WHERE project_id = $1 AND created_at >= now() - interval '1 day'
        GROUP BY model`,
      [projectId],
    ),
  ]);

  const byRole: Record<string, number> = {};
  for (const r of roleRows) byRole[r.role as string] = r.total as number;
  const byModel: Record<string, number> = {};
  for (const r of modelRows) byModel[r.model as string] = r.total as number;
  return { total: totalRows[0]?.total ?? 0, byRole, byModel };
}

/**
 * Project-level cost rollup over an arbitrary range. Used by /api/usage/costs.
 */
export async function getCostsInRange(opts: {
  projectId?: string;
  from?: Date;
  to?: Date;
}): Promise<{ total: number; rows: Array<{ projectId: string; role: string; model: string; total: number }> }> {
  const wheres: string[] = [];
  const vals: unknown[] = [];
  if (opts.projectId) { wheres.push(`project_id = $${vals.length + 1}`); vals.push(opts.projectId); }
  if (opts.from)      { wheres.push(`created_at >= $${vals.length + 1}`); vals.push(opts.from); }
  if (opts.to)        { wheres.push(`created_at < $${vals.length + 1}`); vals.push(opts.to); }
  const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT project_id AS "projectId", role, model,
            COALESCE(SUM(cost_usd), 0)::float8 AS total
       FROM usage_costs ${where}
       GROUP BY project_id, role, model
       ORDER BY total DESC`,
    vals,
  );
  const total = (rows as Array<{ total: number }>).reduce((a, r) => a + r.total, 0);
  return { total, rows: rows as Array<{ projectId: string; role: string; model: string; total: number }> };
}

export class CostCapExceeded extends Error {
  constructor(public readonly cap: number, public readonly spent: number) {
    super(`Daily cost cap reached: $${spent.toFixed(2)} / $${cap.toFixed(2)}`);
    this.name = "CostCapExceeded";
  }
}

/**
 * Pre-spawn check. Throws CostCapExceeded if today's spend already meets or
 * exceeds the project's cap. cap=0 means unlimited (no check).
 */
export async function assertWithinDailyCap(projectId: string, cap: number): Promise<{ spent: number; cap: number }> {
  if (cap <= 0) return { spent: await getDailyCost(projectId), cap };
  const spent = await getDailyCost(projectId);
  if (spent >= cap) throw new CostCapExceeded(cap, spent);
  return { spent, cap };
}

/**
 * Test/utility helper. Lets tests insert synthetic spend without going through
 * the SDK runner.
 */
export async function recordCostRaw(input: {
  projectId: string;
  sessionId?: string | null;
  taskId?: string | null;
  role: string;
  model: string;
  costUsd: number;
  durationMs?: number;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO usage_costs
       (project_id, session_id, task_id, role, model, cost_usd, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.projectId, input.sessionId ?? null, input.taskId ?? null,
      input.role, input.model, input.costUsd, input.durationMs ?? 0,
    ],
  );
  log.debug({ projectId: input.projectId, costUsd: input.costUsd }, "recordCostRaw");
}
