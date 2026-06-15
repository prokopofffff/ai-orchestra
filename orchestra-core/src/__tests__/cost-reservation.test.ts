import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db";
import {
  reserveDailyCost,
  releaseReservation,
  recordCostRaw,
  getDailyCost,
  CostCapExceeded,
} from "../cost-tracker";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let projectId: string;

async function makeSession(role = "backend"): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO sessions (project_id, role, model, status) VALUES ($1, $2, 'sonnet', 'running') RETURNING id`,
    [projectId, role],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
  const pool = getPool();
  await pool.query("DELETE FROM projects WHERE slug = 'cost-resv-test'");
  const { rows } = await pool.query(
    "INSERT INTO projects (name, slug) VALUES ('Cost Resv Test', 'cost-resv-test') RETURNING id",
  );
  projectId = rows[0].id;
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM cost_reservations WHERE project_id = $1", [projectId]);
  await pool.query("DELETE FROM usage_costs WHERE project_id = $1", [projectId]);
  await pool.query("DELETE FROM sessions WHERE project_id = $1", [projectId]);
});

afterAll(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM cost_reservations WHERE project_id = $1", [projectId]).catch(() => {});
  await pool.query("DELETE FROM usage_costs WHERE project_id = $1", [projectId]).catch(() => {});
  await pool.query("DELETE FROM sessions WHERE project_id = $1", [projectId]).catch(() => {});
  await pool.query("DELETE FROM projects WHERE slug = 'cost-resv-test'").catch(() => {});
  await pool.end();
});

describe("cost reservations — atomic reserve-then-spend", () => {
  it("counts unbilled reservations toward the per-project cap", async () => {
    const common = { projectId, estimatedUsd: 6, projectCap: 10, orchestraCap: 0 };
    await reserveDailyCost({ ...common, sessionId: await makeSession() });          // reserved 6 < 10
    await reserveDailyCost({ ...common, sessionId: await makeSession() });          // 6 < 10, reserved 12
    await expect(
      reserveDailyCost({ ...common, sessionId: await makeSession() }),             // 12 >= 10
    ).rejects.toBeInstanceOf(CostCapExceeded);
  });

  it("combines billed spend and reservations", async () => {
    await recordCostRaw({ projectId, role: "backend", model: "sonnet", costUsd: 8 });
    const common = { projectId, estimatedUsd: 5, projectCap: 10, orchestraCap: 0 };
    await reserveDailyCost({ ...common, sessionId: await makeSession() });          // 8 + 0 < 10
    await expect(
      reserveDailyCost({ ...common, sessionId: await makeSession() }),             // 8 + 5 >= 10
    ).rejects.toBeInstanceOf(CostCapExceeded);
  });

  it("releaseReservation frees capacity", async () => {
    const common = { projectId, estimatedUsd: 6, projectCap: 10, orchestraCap: 0 };
    const s1 = await makeSession();
    await reserveDailyCost({ ...common, sessionId: s1 });                           // reserved 6
    await reserveDailyCost({ ...common, sessionId: await makeSession() });          // reserved 12
    const s3 = await makeSession();
    await expect(reserveDailyCost({ ...common, sessionId: s3 })).rejects.toBeInstanceOf(CostCapExceeded);
    await releaseReservation(s1);                                                   // reserved back to 6
    await expect(reserveDailyCost({ ...common, sessionId: s3 })).resolves.toBeUndefined();
  });

  it("does not pollute billed-cost reporting", async () => {
    await reserveDailyCost({ projectId, sessionId: await makeSession(), estimatedUsd: 5, projectCap: 0, orchestraCap: 0 });
    expect(await getDailyCost(projectId)).toBe(0); // reservation excluded from billed total
    await recordCostRaw({ projectId, role: "backend", model: "sonnet", costUsd: 2 });
    expect(await getDailyCost(projectId)).toBe(2);
  });

  it("serializes concurrent reservations — only what fits is admitted", async () => {
    const common = { projectId, estimatedUsd: 5, projectCap: 5, orchestraCap: 0 };
    const results = await Promise.allSettled([
      reserveDailyCost({ ...common, sessionId: await makeSession("backend") }),
      reserveDailyCost({ ...common, sessionId: await makeSession("frontend") }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CostCapExceeded);

    const { rows } = await getPool().query(
      "SELECT COALESCE(SUM(estimated_usd),0)::float8 AS s FROM cost_reservations WHERE project_id = $1",
      [projectId],
    );
    expect(rows[0].s).toBe(5); // exactly one reservation admitted, not two
  });

  it("orchestra-wide cap also counts reservations", async () => {
    // First reservation under unlimited caps establishes $1 of reserved spend.
    await reserveDailyCost({ projectId, sessionId: await makeSession(), estimatedUsd: 1, projectCap: 0, orchestraCap: 0 });
    // A tiny orchestra cap must now trip — the reserved $1 alone exceeds it.
    await expect(
      reserveDailyCost({ projectId, sessionId: await makeSession(), estimatedUsd: 1, projectCap: 0, orchestraCap: 0.5 }),
    ).rejects.toBeInstanceOf(CostCapExceeded);
  });
});
