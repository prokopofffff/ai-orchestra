import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { dispatchSignal } from "../dispatcher";
import { configSchema } from "../config";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

const config = configSchema.parse({ databaseUrl: DATABASE_URL });

let projectId: string;
let taskId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM graphile_worker._private_jobs").catch(() => {});
  await pool.query("DELETE FROM sessions");
  await pool.query("DELETE FROM signals");
  await pool.query("DELETE FROM task_comments");
  await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM conversations");
  await pool.query("DELETE FROM projects WHERE slug = 'dispatch-test'");

  const { rows: projRows } = await pool.query(
    "INSERT INTO projects (name, slug, repo_url) VALUES ('Dispatch Test', 'dispatch-test', 'https://github.com/test/repo') RETURNING id",
  );
  projectId = projRows[0].id;

  const { rows: taskRows } = await pool.query(
    "INSERT INTO tasks (project_id, title, state, assignee_role) VALUES ($1, 'Test Task', 'in_development', 'backend') RETURNING id",
    [projectId],
  );
  taskId = taskRows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

describe("dispatcher", () => {
  it("dispatches create_design to designer", async () => {
    const result = await dispatchSignal(
      { from: "tech-lead", to: "designer", action: "create_design", projectId, taskId },
      config,
    );
    expect(result.dispatched).toBe(true);
    expect(result.role).toBe("designer");
    expect(result.queued).toBe(true);
  });

  it("dispatches assign_dev based on task assignee_role", async () => {
    const result = await dispatchSignal(
      { from: "tech-lead", to: "backend", action: "assign_dev", projectId, taskId },
      config,
    );
    expect(result.dispatched).toBe(true);
    expect(result.role).toBe("backend");
  });

  it("dispatches pr_created to tech-lead for review", async () => {
    const result = await dispatchSignal(
      { from: "backend", to: "tech-lead", action: "pr_created", projectId, taskId },
      config,
    );
    expect(result.dispatched).toBe(true);
    expect(result.role).toBe("tech-lead");
  });

  it("dispatches question to tech-lead", async () => {
    const result = await dispatchSignal(
      { from: "backend", to: "tech-lead", action: "question", projectId, taskId },
      config,
    );
    expect(result.dispatched).toBe(true);
    expect(result.role).toBe("tech-lead");
  });

  it("auto-handles tests_passed (notify TL, no role dispatch)", async () => {
    const result = await dispatchSignal(
      { from: "qa", to: "tech-lead", action: "tests_passed", projectId, taskId },
      config,
    );
    expect(result.dispatched).toBe(true);
    expect(result.role).toBeUndefined();
    expect(result.reason).toMatch(/auto-handled/i);
  });

  it("dispatches setup_cicd to devops", async () => {
    const result = await dispatchSignal(
      { from: "tech-lead", to: "devops", action: "setup_cicd", projectId, taskId },
      config,
    );
    expect(result.dispatched).toBe(true);
    expect(result.role).toBe("devops");
  });

  it("does not dispatch escalate (user notification only)", async () => {
    const result = await dispatchSignal(
      { from: "backend", to: "user", action: "escalate", projectId },
      config,
    );
    expect(result.dispatched).toBe(false);
  });

  it("does not dispatch notify (user notification only)", async () => {
    const result = await dispatchSignal(
      { from: "tech-lead", to: "user", action: "notify", projectId },
      config,
    );
    expect(result.dispatched).toBe(false);
  });

  it("dispatches pr_changes_requested back to dev", async () => {
    const result = await dispatchSignal(
      { from: "tech-lead", to: "backend", action: "pr_changes_requested", projectId, taskId },
      config,
    );
    expect(result.dispatched).toBe(true);
    expect(result.role).toBe("backend");
  });

  it("returns error when assign_dev task has no assignee", async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      "INSERT INTO tasks (project_id, title) VALUES ($1, 'No Assignee') RETURNING id",
      [projectId],
    );
    const result = await dispatchSignal(
      { from: "tech-lead", to: "backend", action: "assign_dev", projectId, taskId: rows[0].id },
      config,
    );
    expect(result.dispatched).toBe(false);
    expect(result.reason).toContain("no assignee_role");
  });
});
