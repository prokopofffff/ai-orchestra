import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import { waitForDatabase, runMigrations, getPool } from "../db";
import {
  recordCostRaw,
  assertWithinDailyCap,
  CostCapExceeded,
} from "../cost-tracker";
import { resolveDailyCostCap } from "../limits";
import { usagePlugin } from "../usage-api";

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
  await pool.query("DELETE FROM projects WHERE slug = 'cap-test'");
  const { rows } = await pool.query(
    "INSERT INTO projects (name, slug) VALUES ('Cap Test', 'cap-test') RETURNING id",
  );
  projectId = rows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

async function buildApp() {
  const app = Fastify();
  await app.register(usagePlugin, { prefix: "/api" });
  await app.ready();
  return app;
}

describe("cost-tracker — daily cap gate", () => {
  it("happy path: under cap returns spent + cap without throwing", async () => {
    await recordCostRaw({ projectId, role: "backend", model: "sonnet", costUsd: 1.0 });
    const r = await assertWithinDailyCap(projectId, 5);
    expect(r.spent).toBeCloseTo(1.0, 5);
    expect(r.cap).toBe(5);
  });

  it("at threshold: equal-to-cap throws", async () => {
    await recordCostRaw({ projectId, role: "backend", model: "sonnet", costUsd: 5.0 });
    await expect(assertWithinDailyCap(projectId, 5)).rejects.toBeInstanceOf(CostCapExceeded);
  });

  it("over threshold: throws and carries cap+spent", async () => {
    await recordCostRaw({ projectId, role: "backend", model: "opus", costUsd: 22.5 });
    try {
      await assertWithinDailyCap(projectId, 20);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CostCapExceeded);
      expect((e as CostCapExceeded).cap).toBe(20);
      expect((e as CostCapExceeded).spent).toBeCloseTo(22.5, 5);
    }
  });

  it("cap=0 is treated as unlimited (never throws)", async () => {
    await recordCostRaw({ projectId, role: "backend", model: "opus", costUsd: 999 });
    await expect(assertWithinDailyCap(projectId, 0)).resolves.toMatchObject({ cap: 0 });
  });
});

describe("limits.resolveDailyCostCap", () => {
  it("returns the in-code default when settings.limits is absent", () => {
    expect(resolveDailyCostCap({})).toBe(20);
  });

  it("returns the project override when present", () => {
    expect(resolveDailyCostCap({ limits: { dailyCostUsd: 50 } })).toBe(50);
  });

  it("returns 0 (unlimited) when explicitly set to 0", () => {
    expect(resolveDailyCostCap({ limits: { dailyCostUsd: 0 } })).toBe(0);
  });

  it("ignores malformed settings", () => {
    expect(resolveDailyCostCap("not an object")).toBe(20);
    expect(resolveDailyCostCap({ limits: "garbage" })).toBe(20);
  });
});

describe("GET /api/usage/today", () => {
  it("returns daily breakdown + configured cap", async () => {
    await recordCostRaw({ projectId, role: "backend", model: "sonnet", costUsd: 0.5 });
    await recordCostRaw({ projectId, role: "qa", model: "haiku", costUsd: 0.1 });
    // override cap for this project
    await getPool().query(
      "UPDATE projects SET settings = $1 WHERE id = $2",
      [JSON.stringify({ limits: { dailyCostUsd: 7 } }), projectId],
    );

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/usage/today?projectId=${projectId}` });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeCloseTo(0.6, 5);
    expect(body.cap).toBe(7);
    expect(body.byRole.backend).toBeCloseTo(0.5, 5);
    expect(body.byModel.haiku).toBeCloseTo(0.1, 5);
  });

  it("400s when projectId is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/usage/today" });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it("404s when project does not exist", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/usage/today?projectId=00000000-0000-0000-0000-000000000000",
    });
    await app.close();
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/usage/costs", () => {
  it("returns total + breakdown for a project range", async () => {
    await recordCostRaw({ projectId, role: "backend", model: "sonnet", costUsd: 0.5 });
    await recordCostRaw({ projectId, role: "backend", model: "opus", costUsd: 1.0 });

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/usage/costs?projectId=${projectId}` });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeCloseTo(1.5, 5);
    expect(body.rows).toHaveLength(2);
  });
});
