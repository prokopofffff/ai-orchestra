import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { scanCostVelocity } from "../cost-velocity-watcher";
import { recordCostRaw } from "../cost-tracker";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let projectId: string;
let taskId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM signals");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM conversations");
  await pool.query("DELETE FROM usage_costs");
  await pool.query("DELETE FROM tasks WHERE title LIKE 'velocity%'");
  await pool.query("DELETE FROM projects WHERE slug LIKE 'velocity%'");

  // Tight cap to avoid pumping $5 in fake spend.
  const settings = JSON.stringify({ limits: { taskHourlyCostUsd: 1 } });
  const { rows: pRows } = await pool.query(
    "INSERT INTO projects (name, slug, settings) VALUES ('Velocity Test', 'velocity-test', $1::jsonb) RETURNING id",
    [settings],
  );
  projectId = pRows[0].id;
  await pool.query("INSERT INTO conversations (project_id) VALUES ($1)", [projectId]);
  const { rows: tRows } = await pool.query(
    `INSERT INTO tasks (project_id, title, state, assignee_role)
     VALUES ($1, 'velocity-task', 'in_development', 'backend') RETURNING id`,
    [projectId],
  );
  taskId = tRows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

describe("cost-velocity-watcher", () => {
  it("freezes a task whose last-hour spend exceeds the cap", async () => {
    await recordCostRaw({ projectId, taskId, role: "backend", model: "opus", costUsd: 1.2 });

    const r = await scanCostVelocity();
    expect(r.frozen).toBe(1);

    const { rows } = await getPool().query(
      "SELECT frozen_reason FROM tasks WHERE id = $1", [taskId],
    );
    expect(rows[0].frozen_reason).toMatch(/Cost velocity/);

    const { rows: sigs } = await getPool().query(
      "SELECT payload FROM signals WHERE project_id = $1 AND action = 'escalate'", [projectId],
    );
    expect(sigs).toHaveLength(1);
    expect(sigs[0].payload).toMatchObject({ event: "cost_velocity" });
  });

  it("ignores spend older than 1 hour", async () => {
    await getPool().query(
      `INSERT INTO usage_costs (project_id, task_id, role, model, cost_usd, created_at)
       VALUES ($1, $2, 'backend', 'opus', 99.0, now() - interval '2 hours')`,
      [projectId, taskId],
    );

    const r = await scanCostVelocity();
    expect(r.frozen).toBe(0);

    const { rows } = await getPool().query(
      "SELECT frozen_reason FROM tasks WHERE id = $1", [taskId],
    );
    expect(rows[0].frozen_reason).toBeNull();
  });

  it("skips already-frozen tasks (no double-escalate)", async () => {
    await getPool().query(
      "UPDATE tasks SET frozen_reason = 'set earlier' WHERE id = $1", [taskId],
    );
    await recordCostRaw({ projectId, taskId, role: "backend", model: "opus", costUsd: 5.0 });

    const r = await scanCostVelocity();
    expect(r.frozen).toBe(0);

    const { rows: sigs } = await getPool().query(
      "SELECT 1 FROM signals WHERE project_id = $1 AND action = 'escalate'", [projectId],
    );
    expect(sigs).toHaveLength(0);
  });
});
