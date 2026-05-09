import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import Fastify from "fastify";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { signalPlugin } from "../signal-api";

vi.mock("../dispatcher", () => ({
  dispatchSignal: vi.fn().mockResolvedValue({ dispatched: false }),
}));

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
  await pool.query("DELETE FROM flow_audit");
  await pool.query("DELETE FROM tasks WHERE title LIKE 'fail-test%'");
  await pool.query("DELETE FROM projects WHERE slug = 'fail-test'");

  const { rows: pRows } = await pool.query(
    "INSERT INTO projects (name, slug) VALUES ('Fail Test', 'fail-test') RETURNING id",
  );
  projectId = pRows[0].id;
  await pool.query("INSERT INTO conversations (project_id) VALUES ($1)", [projectId]);
  const { rows: tRows } = await pool.query(
    `INSERT INTO tasks (project_id, title, state, assignee_role)
     VALUES ($1, 'fail-test-task', 'in_testing', 'backend') RETURNING id`,
    [projectId],
  );
  taskId = tRows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

async function buildApp() {
  const app = Fastify();
  await app.register(signalPlugin, { prefix: "/api" });
  await app.ready();
  return app;
}

async function fail(app: ReturnType<typeof Fastify>) {
  return app.inject({
    method: "POST", url: "/api/signal",
    payload: {
      from: "qa", to: "tech-lead", action: "tests_failed",
      projectId, taskId, payload: { message: "broken" },
    },
  });
}

describe("signal-api — failed-loop counter", () => {
  it("increments failed_count on each tests_failed and freezes at the cap (default 3)", async () => {
    await getPool().query("UPDATE tasks SET failed_count = 2 WHERE id = $1", [taskId]);

    const app = await buildApp();
    const res = await fail(app);
    await app.close();

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("frozen");
    expect(body.reason).toMatch(/Failed-loop cap/);

    const { rows } = await getPool().query(
      "SELECT failed_count, frozen_reason FROM tasks WHERE id = $1", [taskId],
    );
    expect(rows[0].failed_count).toBe(3);
    expect(rows[0].frozen_reason).toMatch(/Failed-loop cap/);

    const { rows: sigs } = await getPool().query(
      "SELECT payload FROM signals WHERE project_id = $1 AND action = 'escalate'",
      [projectId],
    );
    expect(sigs).toHaveLength(1);
    expect(sigs[0].payload).toMatchObject({ event: "failed_cap", count: 3, cap: 3 });
  });

  it("respects per-project maxFails override", async () => {
    await getPool().query(
      "UPDATE projects SET settings = $1 WHERE id = $2",
      [JSON.stringify({ limits: { maxFails: 1 } }), projectId],
    );

    const app = await buildApp();
    const res = await fail(app);
    await app.close();

    expect(res.statusCode).toBe(202);
    const { rows } = await getPool().query(
      "SELECT failed_count, frozen_reason FROM tasks WHERE id = $1", [taskId],
    );
    expect(rows[0].failed_count).toBe(1);
    expect(rows[0].frozen_reason).toMatch(/1\/1/);
  });
});
