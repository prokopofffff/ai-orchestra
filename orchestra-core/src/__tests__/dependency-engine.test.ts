import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { checkUnblocked, getBlockers, wouldCreateCycle } from "../dependency-engine";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let projectId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM flow_audit");
  await pool.query("DELETE FROM signals");
  await pool.query("DELETE FROM task_comments");
  await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM conversations");
  await pool.query("DELETE FROM projects WHERE slug = 'dep-test'");

  const { rows } = await pool.query(
    "INSERT INTO projects (name, slug) VALUES ('Dep Test', 'dep-test') RETURNING id",
  );
  projectId = rows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

describe("dependency-engine", () => {
  describe("checkUnblocked", () => {
    it("emits task_unblocked signal when all blockers are done", async () => {
      const pool = getPool();

      // Create blocker task (merged)
      const { rows: [blocker] } = await pool.query(
        "INSERT INTO tasks (project_id, title, state) VALUES ($1, 'Blocker', 'merged') RETURNING id",
        [projectId],
      );

      // Create blocked task
      const { rows: [blocked] } = await pool.query(
        "INSERT INTO tasks (project_id, title, state, blocked_by) VALUES ($1, 'Blocked', 'new', $2) RETURNING id",
        [projectId, [blocker.id]],
      );

      const unblocked = await checkUnblocked(blocker.id, projectId);
      expect(unblocked).toContain(blocked.id);

      // Verify signal was created
      const { rows: signals } = await pool.query(
        "SELECT * FROM signals WHERE task_id = $1 AND action = 'task_unblocked'",
        [blocked.id],
      );
      expect(signals.length).toBe(1);
      expect(signals[0].to_role).toBe("tech-lead");
    });

    it("does not unblock when other blockers remain", async () => {
      const pool = getPool();

      const { rows: [blocker1] } = await pool.query(
        "INSERT INTO tasks (project_id, title, state) VALUES ($1, 'Blocker 1', 'merged') RETURNING id",
        [projectId],
      );
      const { rows: [blocker2] } = await pool.query(
        "INSERT INTO tasks (project_id, title, state) VALUES ($1, 'Blocker 2', 'in_development') RETURNING id",
        [projectId],
      );

      await pool.query(
        "INSERT INTO tasks (project_id, title, state, blocked_by) VALUES ($1, 'Blocked', 'new', $2)",
        [projectId, [blocker1.id, blocker2.id]],
      );

      const unblocked = await checkUnblocked(blocker1.id, projectId);
      expect(unblocked).toEqual([]);
    });

    it("returns empty when no dependents", async () => {
      const pool = getPool();
      const { rows: [task] } = await pool.query(
        "INSERT INTO tasks (project_id, title, state) VALUES ($1, 'Solo', 'merged') RETURNING id",
        [projectId],
      );

      const unblocked = await checkUnblocked(task.id, projectId);
      expect(unblocked).toEqual([]);
    });

    it("unblocks multiple tasks at once", async () => {
      const pool = getPool();

      const { rows: [blocker] } = await pool.query(
        "INSERT INTO tasks (project_id, title, state) VALUES ($1, 'Shared Blocker', 'merged') RETURNING id",
        [projectId],
      );

      const { rows: [dep1] } = await pool.query(
        "INSERT INTO tasks (project_id, title, state, blocked_by) VALUES ($1, 'Dep 1', 'new', $2) RETURNING id",
        [projectId, [blocker.id]],
      );
      const { rows: [dep2] } = await pool.query(
        "INSERT INTO tasks (project_id, title, state, blocked_by) VALUES ($1, 'Dep 2', 'new', $2) RETURNING id",
        [projectId, [blocker.id]],
      );

      const unblocked = await checkUnblocked(blocker.id, projectId);
      expect(unblocked).toContain(dep1.id);
      expect(unblocked).toContain(dep2.id);
    });
  });

  describe("getBlockers", () => {
    it("returns active blockers", async () => {
      const pool = getPool();

      const { rows: [b1] } = await pool.query(
        "INSERT INTO tasks (project_id, title, state) VALUES ($1, 'Active Blocker', 'in_development') RETURNING id",
        [projectId],
      );
      const { rows: [b2] } = await pool.query(
        "INSERT INTO tasks (project_id, title, state) VALUES ($1, 'Done Blocker', 'merged') RETURNING id",
        [projectId],
      );
      const { rows: [task] } = await pool.query(
        "INSERT INTO tasks (project_id, title, state, blocked_by) VALUES ($1, 'Blocked', 'new', $2) RETURNING id",
        [projectId, [b1.id, b2.id]],
      );

      const blockers = await getBlockers(task.id);
      expect(blockers.length).toBe(1);
      expect(blockers[0].id).toBe(b1.id);
      expect(blockers[0].title).toBe("Active Blocker");
    });

    it("returns empty for unblocked task", async () => {
      const pool = getPool();
      const { rows: [task] } = await pool.query(
        "INSERT INTO tasks (project_id, title) VALUES ($1, 'Free') RETURNING id",
        [projectId],
      );
      const blockers = await getBlockers(task.id);
      expect(blockers).toEqual([]);
    });
  });

  describe("wouldCreateCycle", () => {
    it("detects self-reference", async () => {
      const pool = getPool();
      const { rows: [task] } = await pool.query(
        "INSERT INTO tasks (project_id, title) VALUES ($1, 'Self') RETURNING id",
        [projectId],
      );
      expect(await wouldCreateCycle(task.id, task.id)).toBe(true);
    });

    it("detects A→B→A cycle", async () => {
      const pool = getPool();
      const { rows: [a] } = await pool.query(
        "INSERT INTO tasks (project_id, title) VALUES ($1, 'A') RETURNING id",
        [projectId],
      );
      const { rows: [b] } = await pool.query(
        "INSERT INTO tasks (project_id, title, blocked_by) VALUES ($1, 'B', $2) RETURNING id",
        [projectId, [a.id]],
      );
      // Would adding A blocked_by B create a cycle? Yes: A→B→A
      expect(await wouldCreateCycle(a.id, b.id)).toBe(true);
    });

    it("allows valid dependency", async () => {
      const pool = getPool();
      const { rows: [a] } = await pool.query(
        "INSERT INTO tasks (project_id, title) VALUES ($1, 'A') RETURNING id",
        [projectId],
      );
      const { rows: [b] } = await pool.query(
        "INSERT INTO tasks (project_id, title) VALUES ($1, 'B') RETURNING id",
        [projectId],
      );
      expect(await wouldCreateCycle(a.id, b.id)).toBe(false);
    });

    it("detects deep cycle A→B→C→A", async () => {
      const pool = getPool();
      const { rows: [a] } = await pool.query(
        "INSERT INTO tasks (project_id, title) VALUES ($1, 'A') RETURNING id",
        [projectId],
      );
      const { rows: [b] } = await pool.query(
        "INSERT INTO tasks (project_id, title, blocked_by) VALUES ($1, 'B', $2) RETURNING id",
        [projectId, [a.id]],
      );
      const { rows: [c] } = await pool.query(
        "INSERT INTO tasks (project_id, title, blocked_by) VALUES ($1, 'C', $2) RETURNING id",
        [projectId, [b.id]],
      );
      // Would adding A blocked_by C create a cycle? Yes: A→B→C→A
      expect(await wouldCreateCycle(a.id, c.id)).toBe(true);
    });
  });
});
