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
  await pool.query("DELETE FROM tasks WHERE title LIKE 'rev-test%'");
  await pool.query("DELETE FROM projects WHERE slug = 'rev-test'");

  const userId = await getOrCreateTestUser("rev-test@orchestra.local");
  const { rows: pRows } = await pool.query(
    "INSERT INTO projects (name, slug, owner_id) VALUES ('Rev Test', 'rev-test', $1) RETURNING id",
    [userId],
  );
  projectId = pRows[0].id;
  await pool.query("INSERT INTO conversations (project_id) VALUES ($1)", [projectId]);
  const { rows: tRows } = await pool.query(
    `INSERT INTO tasks (project_id, title, state, assignee_role)
     VALUES ($1, 'rev-test-task', 'pr_created', 'backend') RETURNING id`,
    [projectId],
  );
  taskId = tRows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

async function buildApp() {
  const app = Fastify();
  await setupTestUser(app, "rev-test@orchestra.local");
  await app.register(signalPlugin, { prefix: "/api" });
  await app.ready();
  return app;
}

async function send(app: ReturnType<typeof Fastify>, body: Record<string, unknown>) {
  return app.inject({
    method: "POST", url: "/api/signal",
    payload: { from: "tech-lead", to: "backend", projectId, taskId, ...body },
  });
}

async function getCounters() {
  const { rows } = await getPool().query(
    "SELECT revisions_count, frozen_reason FROM tasks WHERE id = $1", [taskId],
  );
  return rows[0] as { revisions_count: number; frozen_reason: string | null };
}

describe("signal-api — revisions counter", () => {
  it("increments revisions_count on each pr_changes_requested", async () => {
    const app = await buildApp();
    for (let i = 0; i < 3; i++) {
      // alternate: revision then resubmit so state allows pr_changes_requested again
      await send(app, { action: "pr_changes_requested" });
      await getPool().query(
        "UPDATE tasks SET state = 'pr_created' WHERE id = $1", [taskId],
      );
    }
    await app.close();

    const c = await getCounters();
    expect(c.revisions_count).toBe(3);
    expect(c.frozen_reason).toBeNull();
  });

  it("freezes the task when count reaches the cap (default 5)", async () => {
    // Pre-seed counter to one below cap so the next request trips it.
    await getPool().query("UPDATE tasks SET revisions_count = 4 WHERE id = $1", [taskId]);

    const app = await buildApp();
    const res = await send(app, { action: "pr_changes_requested" });
    await app.close();

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("frozen");
    expect(body.reason).toMatch(/Revisions cap/);

    const c = await getCounters();
    expect(c.revisions_count).toBe(5);
    expect(c.frozen_reason).toMatch(/Revisions cap/);

    // escalate signal recorded
    const { rows: sigs } = await getPool().query(
      "SELECT action, payload FROM signals WHERE project_id = $1 AND action = 'escalate'",
      [projectId],
    );
    expect(sigs).toHaveLength(1);
    expect(sigs[0].payload).toMatchObject({ event: "revisions_cap", count: 5, cap: 5 });
  });

  it("respects per-project override of maxRevisions", async () => {
    await getPool().query(
      "UPDATE projects SET settings = $1 WHERE id = $2",
      [JSON.stringify({ limits: { maxRevisions: 2 } }), projectId],
    );
    await getPool().query("UPDATE tasks SET revisions_count = 1 WHERE id = $1", [taskId]);

    const app = await buildApp();
    const res = await send(app, { action: "pr_changes_requested" });
    await app.close();

    expect(res.statusCode).toBe(202);
    const c = await getCounters();
    expect(c.revisions_count).toBe(2);
    expect(c.frozen_reason).toMatch(/2\/2/);
  });
});
