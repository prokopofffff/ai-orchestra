import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { enqueue, getQueueStatus, getRetryCount } from "../rate-limiter";
import { configSchema } from "../config";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

const config = configSchema.parse({ databaseUrl: DATABASE_URL, jwtSecret: "test-test-test-test-test-test" });

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
    it("schedules an agent-run job in graphile-worker", async () => {
      const id = await enqueue({ projectId, taskId, role: "backend", config });
      expect(id).toBeDefined();

      const { rows } = await getPool().query(
        `SELECT t.identifier AS task_identifier, j.priority, j.flags, j.payload
         FROM graphile_worker._private_jobs j
         JOIN graphile_worker._private_tasks t ON t.id = j.task_id
         WHERE j.payload->>'taskId' = $1`,
        [taskId],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].task_identifier).toBe("agent-run");
      expect(rows[0].priority).toBe(40);
      expect(rows[0].flags).toHaveProperty("bucket:claude:api", true);
      expect(rows[0].payload).toMatchObject({ projectId, taskId, role: "backend" });
    });

    it("assigns correct priority per role", async () => {
      const pool = getPool();
      const roles = [
        { role: "tech-lead", expected: 100 },
        { role: "designer",  expected: 50 },
        { role: "frontend",  expected: 40 },
        { role: "qa",        expected: 30 },
        { role: "devops",    expected: 20 },
      ] as const;

      for (const { role, expected } of roles) {
        const { rows: taskRows } = await pool.query(
          "INSERT INTO tasks (project_id, title) VALUES ($1, $2) RETURNING id",
          [projectId, `Task for ${role}`],
        );
        await enqueue({ projectId, taskId: taskRows[0].id, role, config });

        const { rows: jobRows } = await pool.query(
          `SELECT j.priority
           FROM graphile_worker._private_jobs j
           WHERE j.payload->>'taskId' = $1`,
          [taskRows[0].id],
        );
        expect(jobRows[0].priority).toBe(expected);
      }
    });

    it("passes resumeSessionId through to the job payload", async () => {
      await enqueue({
        projectId, taskId, role: "backend", config,
        resumeSessionId: "resume-abc",
      });
      const { rows } = await getPool().query(
        `SELECT payload FROM graphile_worker._private_jobs WHERE payload->>'taskId' = $1`,
        [taskId],
      );
      expect(rows[0].payload.resumeSessionId).toBe("resume-abc");
    });
  });

  describe("getRetryCount", () => {
    it("returns 0 when no agent-run exists yet", async () => {
      expect(await getRetryCount(taskId, "backend")).toBe(0);
    });

    it("returns `attempts` of the most recent matching agent-run job", async () => {
      await enqueue({ projectId, taskId, role: "backend", config });
      // Simulate a run by bumping attempts directly on graphile-worker's table.
      await getPool().query(
        `UPDATE graphile_worker._private_jobs SET attempts = 2
         WHERE payload->>'taskId' = $1`,
        [taskId],
      );
      expect(await getRetryCount(taskId, "backend")).toBe(2);
    });
  });

  describe("getQueueStatus", () => {
    it("returns the expected shape", async () => {
      const status = await getQueueStatus();
      expect(status).toMatchObject({
        rateLimited: false,
        rateLimitResetTime: null,
        queued: expect.any(Number),
        running: expect.any(Number),
        completed: 0, // graphile-worker deletes completed jobs
        failed: expect.any(Number),
      });
    });

    it("counts queued agent-run jobs", async () => {
      await enqueue({ projectId, taskId, role: "backend", config });
      const status = await getQueueStatus();
      expect(status.queued).toBeGreaterThanOrEqual(1);
    });
  });
});
