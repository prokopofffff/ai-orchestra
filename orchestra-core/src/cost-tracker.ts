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
 * Total USD spent across all projects in the last 24h. Used by the
 * orchestra-wide cap so an organisation-level number can complement
 * (or overrule) any per-project setting.
 */
export async function getOrchestraDailyCost(): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
       FROM usage_costs
      WHERE created_at >= now() - interval '1 day'`,
  );
  return rows[0]?.total ?? 0;
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

export type DailyCostPoint = {
  day: string;
  total: number;
  byRole: Record<string, number>;
  byModel: Record<string, number>;
};

/**
 * Per-day cost totals for the last N days, with role + model breakdown per
 * bucket. Backs the dashboard's history chart. Days with zero spend are
 * still emitted so the chart's x-axis is contiguous.
 */
export async function getDailyCostSeries(opts: {
  projectId?: string;
  projectIds?: string[];
  days: number;
}): Promise<DailyCostPoint[]> {
  const days = Math.max(1, Math.min(opts.days, 90));
  const pool = getPool();
  const params: unknown[] = [days];
  let projectFilter = "";
  if (opts.projectId) {
    params.push(opts.projectId);
    projectFilter = ` AND project_id = $${params.length}`;
  } else if (opts.projectIds && opts.projectIds.length > 0) {
    params.push(opts.projectIds);
    projectFilter = ` AND project_id = ANY($${params.length})`;
  }

  // Generate the date axis up front so empty days remain in the result.
  const { rows: axisRows } = await pool.query(
    `SELECT to_char(d::date, 'YYYY-MM-DD') AS day
       FROM generate_series(
         (now() - ($1::int - 1) * interval '1 day')::date,
         now()::date,
         interval '1 day'
       ) AS d`,
    params.slice(0, 1),
  );
  const axis = (axisRows as Array<{ day: string }>).map((r) => r.day);

  const { rows: roleRows } = await pool.query(
    `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day,
            role, COALESCE(SUM(cost_usd), 0)::float8 AS total
       FROM usage_costs
      WHERE created_at >= (now() - ($1::int - 1) * interval '1 day')::date${projectFilter}
      GROUP BY day, role`,
    params,
  );
  const { rows: modelRows } = await pool.query(
    `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day,
            model, COALESCE(SUM(cost_usd), 0)::float8 AS total
       FROM usage_costs
      WHERE created_at >= (now() - ($1::int - 1) * interval '1 day')::date${projectFilter}
      GROUP BY day, model`,
    params,
  );

  const out: Record<string, DailyCostPoint> = {};
  for (const day of axis) out[day] = { day, total: 0, byRole: {}, byModel: {} };
  for (const r of roleRows as Array<{ day: string; role: string; total: number }>) {
    if (!out[r.day]) out[r.day] = { day: r.day, total: 0, byRole: {}, byModel: {} };
    out[r.day].byRole[r.role] = r.total;
    out[r.day].total += r.total;
  }
  for (const r of modelRows as Array<{ day: string; model: string; total: number }>) {
    if (!out[r.day]) out[r.day] = { day: r.day, total: 0, byRole: {}, byModel: {} };
    out[r.day].byModel[r.model] = r.total;
  }
  return axis.map((d) => out[d]);
}

/**
 * Project-level cost rollup over an arbitrary range. Used by /api/usage/costs.
 */
export async function getCostsInRange(opts: {
  projectId?: string;
  projectIds?: string[];
  from?: Date;
  to?: Date;
}): Promise<{ total: number; rows: Array<{ projectId: string; role: string; model: string; total: number }> }> {
  const wheres: string[] = [];
  const vals: unknown[] = [];
  if (opts.projectId) {
    wheres.push(`project_id = $${vals.length + 1}`);
    vals.push(opts.projectId);
  } else if (opts.projectIds && opts.projectIds.length > 0) {
    wheres.push(`project_id = ANY($${vals.length + 1})`);
    vals.push(opts.projectIds);
  }
  if (opts.from) { wheres.push(`created_at >= $${vals.length + 1}`); vals.push(opts.from); }
  if (opts.to)   { wheres.push(`created_at < $${vals.length + 1}`); vals.push(opts.to); }
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
 * Orchestra-wide cap. Reads `orchestra_daily_cost_cap_usd` from system_config
 * (env override `ORCHESTRA_DAILY_COST_CAP_USD`). Missing / 0 = disabled.
 */
export async function assertWithinOrchestraDailyCap(): Promise<{ spent: number; cap: number }> {
  const cap = await getOrchestraDailyCostCap();
  const spent = await getOrchestraDailyCost();
  if (cap > 0 && spent >= cap) throw new CostCapExceeded(cap, spent);
  return { spent, cap };
}

export async function getOrchestraDailyCostCap(): Promise<number> {
  const env = Number(process.env.ORCHESTRA_DAILY_COST_CAP_USD);
  if (Number.isFinite(env) && env >= 0) return env;
  const { rows } = await getPool().query(
    "SELECT value FROM system_config WHERE key = 'orchestra_daily_cost_cap_usd' LIMIT 1",
  ).catch(() => ({ rows: [] as Array<{ value: string }> }));
  const raw = rows[0]?.value;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
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
