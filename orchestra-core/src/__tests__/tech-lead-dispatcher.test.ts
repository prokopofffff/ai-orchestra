import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { dispatchTechLead } from "../tech-lead-dispatcher";
import { configSchema } from "../config";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

const config = configSchema.parse({ databaseUrl: DATABASE_URL, jwtSecret: "test-test-test-test-test-test" });

let projectId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM sessions");
  await pool.query("DELETE FROM signals");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM conversations");
  await pool.query("DELETE FROM projects WHERE slug = 'tld-test'");

  const { rows } = await pool.query(
    "INSERT INTO projects (name, slug) VALUES ('TLD Test', 'tld-test') RETURNING id",
  );
  projectId = rows[0].id;
  await pool.query("INSERT INTO conversations (project_id) VALUES ($1)", [projectId]);
});

afterAll(async () => {
  await getPool().end();
});

describe("tech-lead-dispatcher — dispatchTechLead", () => {
  it("enqueues a user-notify signal when a tech-lead session is already running", async () => {
    const pool = getPool();
    // Seed an active tech-lead session
    await pool.query(
      `INSERT INTO sessions (project_id, role, status, model)
       VALUES ($1, 'tech-lead', 'running', 'opus')`,
      [projectId],
    );

    const result = await dispatchTechLead(projectId, "hey tech lead", config);

    expect(result.action).toBe("already_running");
    expect(result.sessionId).toBeDefined();

    // The message should have been parked as a signal for the live TL to consume.
    const { rows } = await pool.query(
      `SELECT from_role, to_role, action, payload
       FROM signals WHERE project_id = $1`,
      [projectId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].from_role).toBe("user");
    expect(rows[0].to_role).toBe("tech-lead");
    expect(rows[0].action).toBe("notify");
    expect(rows[0].payload).toMatchObject({ message: "hey tech lead" });
  });

  it("returns action=error when the project doesn't exist", async () => {
    const result = await dispatchTechLead(
      "00000000-0000-0000-0000-000000000000",
      "orphan",
      config,
    );
    expect(result.action).toBe("error");
    expect(result.error).toMatch(/Проект не найден/);
  });
});
