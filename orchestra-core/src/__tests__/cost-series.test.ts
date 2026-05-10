import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { getDailyCostSeries, recordCostRaw } from "../cost-tracker";
import { usagePlugin } from "../usage-api";
import { setupTestUser, getOrCreateTestUser } from "./helpers/test-auth";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let projectId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM usage_costs");
  await pool.query("DELETE FROM projects WHERE slug = 'series-test'");
  const userId = await getOrCreateTestUser("series-test@orchestra.local");
  const { rows } = await pool.query(
    "INSERT INTO projects (name, slug, owner_id) VALUES ('Series', 'series-test', $1) RETURNING id",
    [userId],
  );
  projectId = rows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

async function buildApp() {
  const app = Fastify();
  await setupTestUser(app, "series-test@orchestra.local");
  await app.register(usagePlugin, { prefix: "/api" });
  await app.ready();
  return app;
}

async function seedAt(daysAgo: number, costUsd: number, role = "backend", model = "sonnet") {
  await getPool().query(
    `INSERT INTO usage_costs (project_id, role, model, cost_usd, created_at)
     VALUES ($1, $2, $3, $4, now() - $5::int * interval '1 day')`,
    [projectId, role, model, costUsd, daysAgo],
  );
}

describe("getDailyCostSeries", () => {
  it("returns one bucket per day for the requested window, even days with no spend", async () => {
    await seedAt(0, 1.0);
    await seedAt(2, 0.5);

    const series = await getDailyCostSeries({ projectId, days: 7 });
    expect(series).toHaveLength(7);
    // First entry is the oldest day in the window
    const totals = series.map((s) => s.total);
    expect(totals.reduce((a, b) => a + b, 0)).toBeCloseTo(1.5, 5);
    // Today (last bucket) holds the 1.0
    expect(series[6].total).toBeCloseTo(1.0, 5);
    // Two-days-ago bucket holds the 0.5
    expect(series[4].total).toBeCloseTo(0.5, 5);
    // Days with no spend are still present with empty breakdowns
    expect(series[5].total).toBe(0);
    expect(series[5].byRole).toEqual({});
  });

  it("breaks down by role and by model per bucket", async () => {
    await seedAt(0, 0.4, "backend", "sonnet");
    await seedAt(0, 0.6, "qa", "haiku");

    const series = await getDailyCostSeries({ projectId, days: 1 });
    expect(series).toHaveLength(1);
    expect(series[0].byRole).toMatchObject({ backend: 0.4, qa: 0.6 });
    expect(series[0].byModel).toMatchObject({ sonnet: 0.4, haiku: 0.6 });
  });

  it("scopes by projectId — other projects' spend not counted", async () => {
    const { rows } = await getPool().query(
      "INSERT INTO projects (name, slug) VALUES ('Other', 'series-other') RETURNING id",
    );
    const other = rows[0].id;
    await getPool().query(
      `INSERT INTO usage_costs (project_id, role, model, cost_usd) VALUES ($1, 'qa', 'sonnet', 99)`,
      [other],
    );
    await recordCostRaw({ projectId, role: "backend", model: "sonnet", costUsd: 0.5 });

    const series = await getDailyCostSeries({ projectId, days: 7 });
    const total = series.reduce((a, p) => a + p.total, 0);
    expect(total).toBeCloseTo(0.5, 5);

    await getPool().query("DELETE FROM usage_costs WHERE project_id = $1", [other]);
    await getPool().query("DELETE FROM projects WHERE id = $1", [other]);
  });

  it("clamps days to 90", async () => {
    const series = await getDailyCostSeries({ projectId, days: 999 });
    expect(series).toHaveLength(90);
  });
});

describe("GET /api/usage/costs/series", () => {
  it("returns the same shape as the helper", async () => {
    await recordCostRaw({ projectId, role: "backend", model: "opus", costUsd: 0.25 });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/usage/costs/series?projectId=${projectId}&days=3` });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.days).toHaveLength(3);
    expect(body.days[2].byRole.backend).toBeCloseTo(0.25, 5);
  });

  it("400s for invalid projectId", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/usage/costs/series?projectId=not-a-uuid&days=7" });
    await app.close();
    expect(res.statusCode).toBe(400);
  });
});
