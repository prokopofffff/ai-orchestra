import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { buildBootstrapContext, formatBootstrapPrompt } from "../session-context";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let projectId: string;
let taskId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);

  const pool = getPool();
  // Clean up
  await pool.query("DELETE FROM signals");
  await pool.query("DELETE FROM task_comments");
  await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM conversations");
  await pool.query("DELETE FROM projects WHERE slug = 'ctx-test'");

  // Create test data
  const { rows: projRows } = await pool.query(
    "INSERT INTO projects (name, slug) VALUES ('Context Test', 'ctx-test') RETURNING id",
  );
  projectId = projRows[0].id;

  const { rows: taskRows } = await pool.query(
    `INSERT INTO tasks (project_id, title, description, state, assignee_role)
     VALUES ($1, 'Auth API', 'Implement JWT authentication', 'in_development', 'backend')
     RETURNING id`,
    [projectId],
  );
  taskId = taskRows[0].id;

  // Add another task
  await pool.query(
    `INSERT INTO tasks (project_id, title, state, assignee_role)
     VALUES ($1, 'Auth UI', 'new', 'frontend')`,
    [projectId],
  );

  // Add pending signal
  await pool.query(
    `INSERT INTO signals (project_id, task_id, from_role, to_role, action, payload, read)
     VALUES ($1, $2, 'tech-lead', 'backend', 'assign_dev', '{"message": "Start working on auth"}', false)`,
    [projectId, taskId],
  );
});

afterAll(async () => {
  await getPool().end();
});

describe("session-context", () => {
  describe("buildBootstrapContext", () => {
    it("builds context with task info", async () => {
      const ctx = await buildBootstrapContext(projectId, "backend", taskId);
      expect(ctx.role).toBe("backend");
      expect(ctx.projectName).toBe("Context Test");
      expect(ctx.taskTitle).toBe("Auth API");
      expect(ctx.taskDescription).toBe("Implement JWT authentication");
    });

    it("includes pending signals and marks them as read", async () => {
      // Signals were read in previous test, add a new one
      const pool = getPool();
      await pool.query(
        `INSERT INTO signals (project_id, from_role, to_role, action, payload, read)
         VALUES ($1, 'tech-lead', 'backend', 'answer', '{"message": "Use bcrypt"}', false)`,
        [projectId],
      );

      const ctx = await buildBootstrapContext(projectId, "backend");
      expect(ctx.pendingSignals.length).toBe(1);
      expect(ctx.pendingSignals[0].from).toBe("tech-lead");
      expect(ctx.pendingSignals[0].action).toBe("answer");
      expect(ctx.pendingSignals[0].message).toBe("Use bcrypt");

      // Verify signals are now marked as read
      const { rows } = await pool.query(
        "SELECT read FROM signals WHERE project_id = $1 AND to_role = 'backend' AND read = false",
        [projectId],
      );
      expect(rows.length).toBe(0);
    });

    it("includes current project tasks", async () => {
      const ctx = await buildBootstrapContext(projectId, "backend");
      expect(ctx.currentTasks.length).toBeGreaterThanOrEqual(2);
      const authApi = ctx.currentTasks.find((t) => t.title === "Auth API");
      expect(authApi).toBeDefined();
      expect(authApi!.state).toBe("in_development");
    });

    it("builds context without task", async () => {
      const ctx = await buildBootstrapContext(projectId, "tech-lead");
      expect(ctx.taskTitle).toBeNull();
      expect(ctx.taskDescription).toBeNull();
    });
  });

  describe("formatBootstrapPrompt", () => {
    it("formats context into markdown prompt", async () => {
      const ctx = await buildBootstrapContext(projectId, "backend", taskId);
      const prompt = formatBootstrapPrompt(ctx);

      expect(prompt).toContain("**backend**");
      expect(prompt).toContain("**Context Test**");
      expect(prompt).toContain("**Auth API**");
      expect(prompt).toContain("Project Tasks");
    });

    it("includes pending signals section when signals exist", () => {
      const prompt = formatBootstrapPrompt({
        role: "backend",
        projectName: "Test",
        taskTitle: null,
        taskDescription: null,
        acceptanceCriteria: null,
        pendingSignals: [{ from: "tech-lead", action: "answer", message: "Use bcrypt" }],
        currentTasks: [],
        lastSummary: null,
      });

      expect(prompt).toContain("Pending Signals");
      expect(prompt).toContain("tech-lead");
      expect(prompt).toContain("Use bcrypt");
    });

    it("omits sections when empty", () => {
      const prompt = formatBootstrapPrompt({
        role: "backend",
        projectName: "Test",
        taskTitle: null,
        taskDescription: null,
        acceptanceCriteria: null,
        pendingSignals: [],
        currentTasks: [],
        lastSummary: null,
      });

      expect(prompt).not.toContain("Pending Signals");
      expect(prompt).not.toContain("Project Tasks");
      expect(prompt).not.toContain("Previous Session Summary");
    });
  });
});
