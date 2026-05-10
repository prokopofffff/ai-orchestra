import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { dispatchSignal, reconcileOrphanedTasks } from "../dispatcher";
import { configSchema } from "../config";

vi.mock("../rate-limiter", () => ({ enqueue: vi.fn() }));
import { enqueue } from "../rate-limiter";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

const config = configSchema.parse({
  databaseUrl: DATABASE_URL,
  jwtSecret: "test-test-test-test-test-test",
});

let projectId: string;
let taskId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  vi.mocked(enqueue).mockReset();
  const pool = getPool();
  await pool.query("DELETE FROM signals");
  await pool.query("DELETE FROM sessions");
  await pool.query("DELETE FROM tasks WHERE title LIKE 'conc-test%'");
  await pool.query("DELETE FROM projects WHERE slug = 'conc-test'");

  // Tight cap so we don't have to fake 4 sessions.
  const settings = JSON.stringify({ limits: { maxConcurrentSessions: 2 } });
  const { rows: pRows } = await pool.query(
    "INSERT INTO projects (name, slug, settings) VALUES ('Conc Test', 'conc-test', $1::jsonb) RETURNING id",
    [settings],
  );
  projectId = pRows[0].id;
  const { rows: tRows } = await pool.query(
    `INSERT INTO tasks (project_id, title, state, assignee_role)
     VALUES ($1, 'conc-test-task', 'in_development', 'qa') RETURNING id`,
    [projectId],
  );
  taskId = tRows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

async function seedActiveSessions(n: number, role = "frontend") {
  for (let i = 0; i < n; i++) {
    await getPool().query(
      `INSERT INTO sessions (project_id, role, model, status) VALUES ($1, $2, 'sonnet', 'running')`,
      [projectId, role],
    );
  }
}

describe("dispatcher — project concurrency cap", () => {
  it("dispatches under cap", async () => {
    await seedActiveSessions(1);
    const r = await dispatchSignal(
      { from: "qa", to: "tech-lead", action: "tests_failed", projectId, taskId },
      config,
    );
    expect(r.dispatched).toBe(true);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("rejects when active sessions reach cap", async () => {
    await seedActiveSessions(2);
    const r = await dispatchSignal(
      { from: "qa", to: "tech-lead", action: "tests_failed", projectId, taskId },
      config,
    );
    expect(r.dispatched).toBe(false);
    expect(r.reason).toMatch(/concurrency cap/i);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reconcileOrphanedTasks also honours the concurrency cap", async () => {
    await seedActiveSessions(2); // already at cap (=2)
    // Task is in an active state with no session of its own → would normally
    // be reconciled, but the project is over cap so it must be skipped.
    await getPool().query(
      "UPDATE tasks SET state = 'in_development' WHERE id = $1", [taskId],
    );

    await reconcileOrphanedTasks(config);
    // Scoped: vitest runs sibling files in parallel, reconcile scans the
    // whole DB — assert only on calls for our project.
    const ours = vi.mocked(enqueue).mock.calls.filter((c) => {
      const arg = c[0] as { projectId?: string };
      return arg?.projectId === projectId;
    });
    expect(ours).toHaveLength(0);
  });

  it("counts only sessions of the same project", async () => {
    // Other-project sessions don't count
    const { rows: other } = await getPool().query(
      "INSERT INTO projects (name, slug) VALUES ('Other', 'conc-other') RETURNING id",
    );
    for (let i = 0; i < 5; i++) {
      await getPool().query(
        `INSERT INTO sessions (project_id, role, model, status) VALUES ($1, 'frontend', 'sonnet', 'running')`,
        [other[0].id],
      );
    }

    const r = await dispatchSignal(
      { from: "qa", to: "tech-lead", action: "tests_failed", projectId, taskId },
      config,
    );
    expect(r.dispatched).toBe(true);

    await getPool().query("DELETE FROM sessions WHERE project_id = $1", [other[0].id]);
    await getPool().query("DELETE FROM projects WHERE id = $1", [other[0].id]);
  });
});
