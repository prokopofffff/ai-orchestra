import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { waitForDatabase, runMigrations, getPool } from "../db";
import {
  recordCost,
  recordCostRaw,
  getDailyCost,
  getDailyCostBreakdown,
  getCostsInRange,
} from "../cost-tracker";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let projectId: string;
let sessionId: string;
let taskId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM usage_costs");
  await pool.query("DELETE FROM sessions");
  await pool.query("DELETE FROM tasks WHERE title LIKE 'cost-test%'");
  await pool.query("DELETE FROM projects WHERE slug = 'cost-test'");

  const { rows: pRows } = await pool.query(
    "INSERT INTO projects (name, slug) VALUES ('Cost Test', 'cost-test') RETURNING id",
  );
  projectId = pRows[0].id;
  const { rows: tRows } = await pool.query(
    "INSERT INTO tasks (project_id, title) VALUES ($1, 'cost-test-task') RETURNING id",
    [projectId],
  );
  taskId = tRows[0].id;
  const { rows: sRows } = await pool.query(
    `INSERT INTO sessions (project_id, role, task_id, model, status)
     VALUES ($1, 'backend', $2, 'sonnet', 'running') RETURNING id`,
    [projectId, taskId],
  );
  sessionId = sRows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

function fakeResult(modelUsage: Record<string, {
  costUSD: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}>): SDKResultMessage {
  // Build a structurally-correct SDKResultMessage with the modelUsage we want.
  // Only fields recordCost reads need to be present.
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1234,
    duration_api_ms: 1234,
    is_error: false,
    num_turns: 1,
    result: "ok",
    stop_reason: null,
    total_cost_usd: Object.values(modelUsage).reduce((a, m) => a + m.costUSD, 0),
    // SDK shape — recordCost only touches fields it knows.
    usage: {} as unknown as SDKResultMessage["usage"],
    modelUsage: Object.fromEntries(
      Object.entries(modelUsage).map(([m, u]) => [m, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
        ...u,
      }]),
    ) as SDKResultMessage["modelUsage"],
    permission_denials: [],
    errors: [],
    uuid: "00000000-0000-0000-0000-000000000000",
    session_id: "fake",
  } as unknown as SDKResultMessage;
}

describe("cost-tracker — recordCost", () => {
  it("inserts one row per model with the SDK's costUSD breakdown", async () => {
    await recordCost({
      projectId, sessionId, taskId, role: "backend",
      result: fakeResult({
        "claude-sonnet-4-6": { costUSD: 0.42, inputTokens: 1000, outputTokens: 500 },
        "claude-haiku-4-5":  { costUSD: 0.01, inputTokens: 200, outputTokens: 100 },
      }),
    });

    const { rows } = await getPool().query(
      `SELECT model, cost_usd::float8 AS cost, input_tokens, output_tokens, result_subtype
         FROM usage_costs WHERE project_id = $1 ORDER BY model`,
      [projectId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      model: "claude-haiku-4-5", cost: 0.01, input_tokens: 200, output_tokens: 100, result_subtype: "success",
    });
    expect(rows[1]).toMatchObject({
      model: "claude-sonnet-4-6", cost: 0.42, input_tokens: 1000, output_tokens: 500,
    });
  });

  it("falls back to total_cost_usd when modelUsage is empty", async () => {
    const result = fakeResult({});
    (result as { total_cost_usd: number }).total_cost_usd = 0.07;

    await recordCost({ projectId, sessionId, taskId, role: "qa", result });

    const { rows } = await getPool().query(
      `SELECT model, cost_usd::float8 AS cost FROM usage_costs WHERE project_id = $1`,
      [projectId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "unknown", cost: 0.07 });
  });

  it("does nothing when both modelUsage and total_cost_usd are zero", async () => {
    await recordCost({ projectId, sessionId, taskId, role: "qa", result: fakeResult({}) });
    const { rows } = await getPool().query(`SELECT 1 FROM usage_costs WHERE project_id = $1`, [projectId]);
    expect(rows).toHaveLength(0);
  });
});

describe("cost-tracker — aggregations", () => {
  it("getDailyCost sums spend across all rows for the project", async () => {
    await recordCostRaw({ projectId, sessionId, taskId, role: "backend", model: "sonnet", costUsd: 1.5 });
    await recordCostRaw({ projectId, sessionId, taskId, role: "qa",      model: "sonnet", costUsd: 0.5 });

    expect(await getDailyCost(projectId)).toBeCloseTo(2.0, 5);
  });

  it("getDailyCost ignores rows older than 24h", async () => {
    await recordCostRaw({ projectId, sessionId, taskId, role: "backend", model: "sonnet", costUsd: 0.3 });
    await getPool().query(
      `INSERT INTO usage_costs (project_id, session_id, task_id, role, model, cost_usd, created_at)
       VALUES ($1, $2, $3, 'backend', 'sonnet', 99.0, now() - interval '2 days')`,
      [projectId, sessionId, taskId],
    );
    expect(await getDailyCost(projectId)).toBeCloseTo(0.3, 5);
  });

  it("getDailyCostBreakdown groups by role and model", async () => {
    await recordCostRaw({ projectId, sessionId, taskId, role: "backend", model: "sonnet", costUsd: 0.4 });
    await recordCostRaw({ projectId, sessionId, taskId, role: "backend", model: "opus",   costUsd: 1.0 });
    await recordCostRaw({ projectId, sessionId, taskId, role: "qa",      model: "sonnet", costUsd: 0.1 });

    const b = await getDailyCostBreakdown(projectId);
    expect(b.total).toBeCloseTo(1.5, 5);
    expect(b.byRole.backend).toBeCloseTo(1.4, 5);
    expect(b.byRole.qa).toBeCloseTo(0.1, 5);
    expect(b.byModel.sonnet).toBeCloseTo(0.5, 5);
    expect(b.byModel.opus).toBeCloseTo(1.0, 5);
  });

  it("getCostsInRange filters by project and time", async () => {
    await recordCostRaw({ projectId, sessionId, taskId, role: "backend", model: "sonnet", costUsd: 0.4 });
    const r = await getCostsInRange({ projectId });
    expect(r.total).toBeCloseTo(0.4, 5);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ projectId, role: "backend", model: "sonnet" });
  });
});
