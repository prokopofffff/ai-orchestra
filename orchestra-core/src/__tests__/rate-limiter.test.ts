import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { enqueue, getQueueStatus, reconcileQueue } from "../rate-limiter";
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
  await pool.query("DELETE FROM task_queue");
  await pool.query("DELETE FROM sessions");
  await pool.query("DELETE FROM signals");
  await pool.query("DELETE FROM task_comments");
  await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM conversations");
  await pool.query("DELETE FROM projects WHERE slug = 'rl-test'");

  const { rows: projRows } = await pool.query(
    "INSERT INTO projects (name, slug, repo_url) VALUES ('RL Test', 'rl-test', 'https://github.com/test/rl') RETURNING id",
  );
  projectId = projRows[0].id;

  const { rows: taskRows } = await pool.query(
    "INSERT INTO tasks (project_id, title) VALUES ($1, 'RL Task') RETURNING id",
    [projectId],
  );
  taskId = taskRows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

describe("rate-limiter", () => {
  describe("enqueue", () => {
    it("adds item to queue", async () => {
      const id = await enqueue({
        projectId,
        taskId,
        role: "backend",
        config,
      });
      expect(id).toBeDefined();

      // Item may have been processed async (and failed due to no real repo),
      // so check it exists in any status
      const { rows } = await getPool().query("SELECT * FROM task_queue WHERE id = $1", [id]);
      expect(rows.length).toBe(1);
      expect(rows[0].role).toBe("backend");
      expect(rows[0].priority).toBe(40);
      expect(["queued", "running", "failed"]).toContain(rows[0].status);
    });

    it("assigns correct priority per role", async () => {
      const pool = getPool();

      // Create tasks for different roles
      const roles = [
        { role: "tech-lead", expected: 100 },
        { role: "designer", expected: 50 },
        { role: "frontend", expected: 40 },
        { role: "qa", expected: 30 },
        { role: "devops", expected: 20 },
      ] as const;

      for (const { role, expected } of roles) {
        const { rows } = await pool.query(
          "INSERT INTO tasks (project_id, title) VALUES ($1, $2) RETURNING id",
          [projectId, `Task for ${role}`],
        );

        const id = await enqueue({
          projectId,
          taskId: rows[0].id,
          role,
          config,
        });

        const { rows: qRows } = await pool.query("SELECT priority FROM task_queue WHERE id = $1", [id]);
        expect(qRows[0].priority).toBe(expected);
      }
    });

    it("sets retry count", async () => {
      // Use the same projectId/taskId from beforeEach (already created)
      const id = await enqueue({
        projectId,
        taskId,
        role: "backend",
        config,
        retryCount: 2,
      });

      const { rows } = await getPool().query("SELECT retry_count FROM task_queue WHERE id = $1", [id]);
      expect(rows[0].retry_count).toBe(2);
    });
  });

  describe("getQueueStatus", () => {
    it("returns queue status shape", async () => {
      const status = await getQueueStatus();
      expect(status).toHaveProperty("rateLimited");
      expect(status).toHaveProperty("rateLimitResetTime");
      expect(status).toHaveProperty("queued");
      expect(status).toHaveProperty("running");
      expect(status).toHaveProperty("completed");
      expect(status).toHaveProperty("failed");
      expect(status.rateLimited).toBe(false);
    });
  });

  describe("reconcileQueue", () => {
    it("moves stuck running items back to queued", async () => {
      const pool = getPool();
      // Manually insert a 'running' item (simulating crash)
      await pool.query(
        "INSERT INTO task_queue (project_id, task_id, role, priority, status) VALUES ($1, $2, 'backend', 40, 'running')",
        [projectId, taskId],
      );

      await reconcileQueue();

      const { rows } = await pool.query("SELECT status FROM task_queue WHERE task_id = $1", [taskId]);
      expect(rows[0].status).toBe("queued");
    });
  });
});
