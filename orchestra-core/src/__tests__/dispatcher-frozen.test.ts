import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { dispatchSignal, reconcileOrphanedTasks } from "../dispatcher";
import { configSchema } from "../config";

vi.mock("../rate-limiter", () => ({
  enqueue: vi.fn(),
}));

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
  await pool.query("DELETE FROM tasks WHERE title LIKE 'frozen-test%'");
  await pool.query("DELETE FROM projects WHERE slug = 'frozen-test'");

  const { rows: pRows } = await pool.query(
    "INSERT INTO projects (name, slug) VALUES ('Frozen Test', 'frozen-test') RETURNING id",
  );
  projectId = pRows[0].id;
  const { rows: tRows } = await pool.query(
    `INSERT INTO tasks (project_id, title, state, assignee_role)
     VALUES ($1, 'frozen-test-task', 'in_development', 'backend') RETURNING id`,
    [projectId],
  );
  taskId = tRows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

describe("dispatcher — frozen_reason gate", () => {
  it("does not enqueue when frozen_reason is set on the task", async () => {
    await getPool().query(
      "UPDATE tasks SET frozen_reason = $1 WHERE id = $2",
      ["revisions cap", taskId],
    );

    const result = await dispatchSignal(
      { from: "tech-lead", to: "backend", action: "assign_dev", projectId, taskId },
      config,
    );

    expect(result.dispatched).toBe(false);
    expect(result.reason).toMatch(/frozen/i);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("dispatches normally when frozen_reason is null", async () => {
    const result = await dispatchSignal(
      { from: "tech-lead", to: "backend", action: "assign_dev", projectId, taskId },
      config,
    );

    expect(result.dispatched).toBe(true);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("reconcileOrphanedTasks skips frozen tasks", async () => {
    await getPool().query(
      "UPDATE tasks SET frozen_reason = $1 WHERE id = $2",
      ["budget cap", taskId],
    );

    await reconcileOrphanedTasks(config);

    // Scoped: vitest may run sibling files in parallel, leaving foreign
    // active tasks the reconciler also picks up — assert only on our project.
    expect(enqueueCallsForProject(projectId)).toHaveLength(0);
  });

  it("reconcileOrphanedTasks picks up non-frozen orphans", async () => {
    await reconcileOrphanedTasks(config);
    expect(enqueueCallsForProject(projectId)).toHaveLength(1);
  });
});

function enqueueCallsForProject(pid: string) {
  return vi.mocked(enqueue).mock.calls.filter((c) => {
    const arg = c[0] as { projectId?: string };
    return arg?.projectId === pid;
  });
}
