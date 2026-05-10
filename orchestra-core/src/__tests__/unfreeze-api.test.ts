import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { taskPlugin } from "../task-api";
import { setupTestUser } from "./helpers/test-auth";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let projectId: string;
let taskId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

let userId: string;

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM tasks WHERE title LIKE 'unfreeze-test%'");
  await pool.query("DELETE FROM projects WHERE slug = 'unfreeze-test'");
  await pool.query("DELETE FROM users WHERE email = 'unfreeze-test@orchestra.local'");

  // Create a stub user up front; setupTestUser also installs the auth hook
  // each time buildApp() runs.
  const { rows: u } = await pool.query(
    `INSERT INTO users (email, username, password_hash)
     VALUES ('unfreeze-test@orchestra.local', 'unfreezetest', 'stub') RETURNING id`,
  );
  userId = u[0].id;

  const { rows: pRows } = await pool.query(
    "INSERT INTO projects (name, slug, owner_id) VALUES ('Unfreeze Test', 'unfreeze-test', $1) RETURNING id",
    [userId],
  );
  projectId = pRows[0].id;
  const { rows: tRows } = await pool.query(
    `INSERT INTO tasks (project_id, title, frozen_reason, revisions_count, failed_count, signals_count)
     VALUES ($1, 'unfreeze-test-task', 'revisions cap', 5, 2, 50)
     RETURNING id`,
    [projectId],
  );
  taskId = tRows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

async function buildApp() {
  const app = Fastify();
  await setupTestUser(app, "unfreeze-test@orchestra.local");
  await app.register(taskPlugin);
  await app.ready();
  return app;
}

describe("POST /tasks/:id/unfreeze", () => {
  it("clears frozen_reason and resets all safety counters atomically", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/tasks/${taskId}/unfreeze` });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.frozenReason).toBeNull();
    expect(body.revisionsCount).toBe(0);
    expect(body.failedCount).toBe(0);
    expect(body.signalsCount).toBe(0);

    const { rows } = await getPool().query(
      "SELECT frozen_reason, revisions_count, failed_count, signals_count FROM tasks WHERE id = $1",
      [taskId],
    );
    expect(rows[0]).toMatchObject({
      frozen_reason: null, revisions_count: 0, failed_count: 0, signals_count: 0,
    });
  });

  it("returns 404 for unknown task", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/tasks/00000000-0000-0000-0000-000000000000/unfreeze",
    });
    await app.close();
    expect(res.statusCode).toBe(404);
  });
});
