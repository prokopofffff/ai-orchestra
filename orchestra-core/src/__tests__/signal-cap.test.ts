import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import Fastify from "fastify";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { signalPlugin } from "../signal-api";
import { setupTestUser, getOrCreateTestUser } from "./helpers/test-auth";

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
  await pool.query("DELETE FROM tasks WHERE title LIKE 'sigcap-test%'");
  await pool.query("DELETE FROM projects WHERE slug = 'sigcap-test'");

  const userId = await getOrCreateTestUser("sigcap-test@orchestra.local");
  // Use a tiny override so we don't need to send 200 signals.
  const settings = JSON.stringify({ limits: { maxSignalsPerTask: 3 } });
  const { rows: pRows } = await pool.query(
    "INSERT INTO projects (name, slug, settings, owner_id) VALUES ('SigCap Test', 'sigcap-test', $1::jsonb, $2) RETURNING id",
    [settings, userId],
  );
  projectId = pRows[0].id;
  await pool.query("INSERT INTO conversations (project_id) VALUES ($1)", [projectId]);
  const { rows: tRows } = await pool.query(
    `INSERT INTO tasks (project_id, title, state, assignee_role)
     VALUES ($1, 'sigcap-test-task', 'in_development', 'backend') RETURNING id`,
    [projectId],
  );
  taskId = tRows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

async function buildApp() {
  const app = Fastify();
  await setupTestUser(app, "sigcap-test@orchestra.local");
  await app.register(signalPlugin, { prefix: "/api" });
  await app.ready();
  return app;
}

async function sendNotify(app: ReturnType<typeof Fastify>) {
  // tech-lead → backend "notify" is a store-only signal that doesn't transition state.
  return app.inject({
    method: "POST", url: "/api/signal",
    payload: {
      from: "tech-lead", to: "backend", action: "notify",
      projectId, taskId, payload: { message: "tick" },
    },
  });
}

describe("signal-api — per-task signal cap", () => {
  it("accepts up-to-cap signals, escalates exactly once at the boundary, then 429s further", async () => {
    const app = await buildApp();

    // 1st, 2nd → ok and not yet at cap
    expect((await sendNotify(app)).statusCode).toBe(201);
    expect((await sendNotify(app)).statusCode).toBe(201);
    // 3rd → still accepted, this one trips the boundary (count == cap == 3)
    expect((await sendNotify(app)).statusCode).toBe(201);
    // 4th → silent reject
    const rejected = await sendNotify(app);
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json()).toMatchObject({ error: expect.stringMatching(/Signal cap/i) });
    // 5th → still rejected, no further escalate
    expect((await sendNotify(app)).statusCode).toBe(429);

    await app.close();

    const { rows } = await getPool().query(
      "SELECT signals_count FROM tasks WHERE id = $1", [taskId],
    );
    expect(rows[0].signals_count).toBe(3);

    const { rows: escalates } = await getPool().query(
      "SELECT payload FROM signals WHERE project_id = $1 AND action = 'escalate'",
      [projectId],
    );
    expect(escalates).toHaveLength(1);
    expect(escalates[0].payload).toMatchObject({ event: "signal_cap", count: 3, cap: 3 });

    const { rows: audits } = await getPool().query(
      "SELECT status, reason FROM flow_audit WHERE project_id = $1 AND status = 'rejected'",
      [projectId],
    );
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits[0].reason).toBe("signal_cap_exceeded");
  });

  it("does not count cross-task signals against each other", async () => {
    const pool = getPool();
    const { rows: tRows } = await pool.query(
      `INSERT INTO tasks (project_id, title, state, assignee_role)
       VALUES ($1, 'sigcap-test-other', 'in_development', 'backend') RETURNING id`,
      [projectId],
    );
    const otherTask = tRows[0].id;

    const app = await buildApp();
    // Cap is 3 for the original task
    await sendNotify(app);
    await sendNotify(app);
    await sendNotify(app);

    // Other task's counter is independent, should still accept
    const res = await app.inject({
      method: "POST", url: "/api/signal",
      payload: {
        from: "tech-lead", to: "backend", action: "notify",
        projectId, taskId: otherTask, payload: { message: "ok" },
      },
    });
    await app.close();

    expect(res.statusCode).toBe(201);
  });
});
