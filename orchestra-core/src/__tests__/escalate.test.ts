import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { escalate } from "../notification-hub";

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
  await pool.query("DELETE FROM signals WHERE from_role = 'system' AND to_role = 'user'");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM conversations");
  await pool.query("DELETE FROM tasks WHERE title LIKE 'escalate-test%'");
  await pool.query("DELETE FROM projects WHERE slug = 'escalate-test'");

  const { rows } = await pool.query(
    "INSERT INTO projects (name, slug) VALUES ('Escalate Test', 'escalate-test') RETURNING id",
  );
  projectId = rows[0].id;
  await pool.query("INSERT INTO conversations (project_id) VALUES ($1)", [projectId]);
  const { rows: tRows } = await pool.query(
    "INSERT INTO tasks (project_id, title) VALUES ($1, 'escalate-test-task') RETURNING id",
    [projectId],
  );
  taskId = tRows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

describe("escalate()", () => {
  it("inserts a system→user escalate signal with the reason in payload", async () => {
    await escalate(projectId, taskId, "loop detected");

    const { rows } = await getPool().query(
      `SELECT from_role, to_role, action, payload, task_id
         FROM signals
        WHERE project_id = $1 AND action = 'escalate'`,
      [projectId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].from_role).toBe("system");
    expect(rows[0].to_role).toBe("user");
    expect(rows[0].task_id).toBe(taskId);
    expect(rows[0].payload).toMatchObject({ message: "loop detected" });
  });

  it("works without a task (project-level escalation)", async () => {
    await escalate(projectId, null, "daily cost cap exceeded");

    const { rows } = await getPool().query(
      `SELECT task_id, payload FROM signals WHERE project_id = $1 AND action = 'escalate'`,
      [projectId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].task_id).toBeNull();
    expect(rows[0].payload).toMatchObject({ message: "daily cost cap exceeded" });
  });

  it("merges metadata into the signal payload", async () => {
    await escalate(projectId, taskId, "revisions cap", { count: 5, cap: 5 });

    const { rows } = await getPool().query(
      `SELECT payload FROM signals WHERE project_id = $1 AND action = 'escalate'`,
      [projectId],
    );
    expect(rows[0].payload).toMatchObject({
      message: "revisions cap",
      count: 5,
      cap: 5,
    });
  });

  it("posts a high-priority system message to the conversation", async () => {
    await escalate(projectId, taskId, "stuck");

    const { rows } = await getPool().query(
      `SELECT m.from_role, m.text, m.metadata
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.project_id = $1`,
      [projectId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].from_role).toBe("system");
    expect(rows[0].text).toContain("stuck");
    expect(rows[0].metadata).toMatchObject({ event: "escalation", taskId });
  });
});
