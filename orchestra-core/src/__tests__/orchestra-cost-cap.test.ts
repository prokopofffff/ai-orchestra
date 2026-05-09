import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db";
import {
  recordCostRaw,
  assertWithinOrchestraDailyCap,
  CostCapExceeded,
  getOrchestraDailyCost,
  getOrchestraDailyCostCap,
} from "../cost-tracker";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let pA: string;
let pB: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM usage_costs");
  await pool.query("DELETE FROM projects WHERE slug LIKE 'org-cap%'");
  await pool.query("DELETE FROM system_config WHERE key = 'orchestra_daily_cost_cap_usd'");
  const a = await pool.query("INSERT INTO projects (name, slug) VALUES ('A', 'org-cap-a') RETURNING id");
  const b = await pool.query("INSERT INTO projects (name, slug) VALUES ('B', 'org-cap-b') RETURNING id");
  pA = a.rows[0].id; pB = b.rows[0].id;
});

afterEach(() => { delete process.env.ORCHESTRA_DAILY_COST_CAP_USD; });

afterAll(async () => {
  await getPool().end();
});

describe("orchestra-wide daily cost cap", () => {
  it("getOrchestraDailyCost sums across all projects", async () => {
    await recordCostRaw({ projectId: pA, role: "backend", model: "sonnet", costUsd: 1.5 });
    await recordCostRaw({ projectId: pB, role: "qa",      model: "sonnet", costUsd: 0.5 });
    expect(await getOrchestraDailyCost()).toBeCloseTo(2.0, 5);
  });

  it("env var beats system_config when both set", async () => {
    await getPool().query(
      "INSERT INTO system_config (key, value) VALUES ('orchestra_daily_cost_cap_usd', '50')",
    );
    process.env.ORCHESTRA_DAILY_COST_CAP_USD = "10";
    expect(await getOrchestraDailyCostCap()).toBe(10);
  });

  it("falls back to system_config when env var absent", async () => {
    await getPool().query(
      "INSERT INTO system_config (key, value) VALUES ('orchestra_daily_cost_cap_usd', '15')",
    );
    expect(await getOrchestraDailyCostCap()).toBe(15);
  });

  it("returns 0 (disabled) when neither env nor config set", async () => {
    expect(await getOrchestraDailyCostCap()).toBe(0);
  });

  it("assertWithinOrchestraDailyCap throws when cumulative spend >= cap", async () => {
    process.env.ORCHESTRA_DAILY_COST_CAP_USD = "2";
    await recordCostRaw({ projectId: pA, role: "backend", model: "sonnet", costUsd: 1.0 });
    await recordCostRaw({ projectId: pB, role: "qa",      model: "sonnet", costUsd: 1.5 });
    await expect(assertWithinOrchestraDailyCap()).rejects.toBeInstanceOf(CostCapExceeded);
  });

  it("does not throw when cap is 0 (disabled) regardless of spend", async () => {
    await recordCostRaw({ projectId: pA, role: "backend", model: "sonnet", costUsd: 9999 });
    await expect(assertWithinOrchestraDailyCap()).resolves.toMatchObject({ cap: 0 });
  });
});
