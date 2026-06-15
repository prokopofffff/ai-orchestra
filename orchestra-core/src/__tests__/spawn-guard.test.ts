import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db";
import {
  createSession,
  terminateSession,
  SpawnConflictError,
} from "../session-manager";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let projectId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);

  const pool = getPool();
  await pool.query("DELETE FROM projects WHERE slug = 'spawn-guard-test'");
  const { rows } = await pool.query(
    "INSERT INTO projects (name, slug) VALUES ('Spawn Guard Test', 'spawn-guard-test') RETURNING id",
  );
  projectId = rows[0].id;
  await pool.query("DELETE FROM sessions WHERE project_id = $1", [projectId]);
});

afterAll(async () => {
  await getPool().query("DELETE FROM sessions WHERE project_id = $1", [projectId]).catch(() => {});
  await getPool().query("DELETE FROM projects WHERE slug = 'spawn-guard-test'").catch(() => {});
  await getPool().end();
});

describe("createSession — atomic spawn guard", () => {
  it("allows the first session for a role", async () => {
    const s = await createSession({ projectId, role: "backend", model: "sonnet" });
    expect(s.status).toBe("running");
    expect(s.role).toBe("backend");
  });

  it("rejects a second running session for the same role (role-busy)", async () => {
    await expect(
      createSession({ projectId, role: "backend", model: "sonnet" }),
    ).rejects.toMatchObject({ name: "SpawnConflictError", reason: "role-busy" });
  });

  it("surfaces the existing session id on a role-busy conflict", async () => {
    try {
      await createSession({ projectId, role: "backend", model: "sonnet" });
      throw new Error("expected SpawnConflictError");
    } catch (err) {
      expect(err).toBeInstanceOf(SpawnConflictError);
      expect((err as SpawnConflictError).detail.existingSessionId).toBeTruthy();
    }
  });

  it("enforces the project concurrency cap atomically", async () => {
    // One backend session is already running → a cap of 1 must reject a
    // different role too (the cap counts across roles, not per role).
    await expect(
      createSession({ projectId, role: "frontend", model: "sonnet", maxConcurrent: 1 }),
    ).rejects.toMatchObject({ name: "SpawnConflictError", reason: "concurrency-cap" });
  });

  it("allows a role again once its running session ends", async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      "SELECT id FROM sessions WHERE project_id = $1 AND role = 'backend' AND status = 'running'",
      [projectId],
    );
    await terminateSession(rows[0].id);
    const s = await createSession({ projectId, role: "backend", model: "sonnet" });
    expect(s.status).toBe("running");
  });

  it("serializes concurrent spawns of the same role — exactly one wins", async () => {
    await getPool().query("DELETE FROM sessions WHERE project_id = $1", [projectId]);

    const results = await Promise.allSettled([
      createSession({ projectId, role: "qa", model: "sonnet" }),
      createSession({ projectId, role: "qa", model: "sonnet" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SpawnConflictError);

    // And the DB has exactly one running qa session, not two.
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS c FROM sessions WHERE project_id = $1 AND role = 'qa' AND status = 'running'",
      [projectId],
    );
    expect(rows[0].c).toBe(1);
  });
});
