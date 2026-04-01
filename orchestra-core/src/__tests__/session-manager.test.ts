import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db.js";
import {
  createSession,
  updateSession,
  getSession,
  getActiveSessionForRole,
  getActiveSessions,
  getLastSessionForRole,
  terminateSession,
  updateHeartbeat,
} from "../session-manager.js";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let projectId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);

  const pool = getPool();
  await pool.query("DELETE FROM sessions");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM conversations");
  await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM projects WHERE slug = 'session-test'");

  const { rows } = await pool.query(
    "INSERT INTO projects (name, slug) VALUES ('Session Test', 'session-test') RETURNING id",
  );
  projectId = rows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

describe("session-manager", () => {
  let sessionId: string;

  it("creates a session", async () => {
    const session = await createSession({
      projectId,
      role: "backend",
      model: "sonnet",
      taskId: undefined,
    });
    expect(session.id).toBeDefined();
    expect(session.projectId).toBe(projectId);
    expect(session.role).toBe("backend");
    expect(session.status).toBe("running");
    expect(session.model).toBe("sonnet");
    expect(session.pid).toBeNull();
    sessionId = session.id;
  });

  it("gets session by id", async () => {
    const session = await getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(sessionId);
    expect(session!.role).toBe("backend");
  });

  it("returns null for unknown session", async () => {
    const session = await getSession("00000000-0000-0000-0000-000000000000");
    expect(session).toBeNull();
  });

  it("updates session fields", async () => {
    const updated = await updateSession(sessionId, {
      pid: 12345,
      claudeSessionId: "claude-abc123",
    });
    expect(updated!.pid).toBe(12345);
    expect(updated!.claudeSessionId).toBe("claude-abc123");
  });

  it("updates heartbeat", async () => {
    await updateHeartbeat(sessionId);
    const session = await getSession(sessionId);
    expect(session!.lastHeartbeat).not.toBeNull();
  });

  it("finds active session for role", async () => {
    const session = await getActiveSessionForRole(projectId, "backend");
    expect(session).not.toBeNull();
    expect(session!.id).toBe(sessionId);
  });

  it("returns null when no active session for role", async () => {
    const session = await getActiveSessionForRole(projectId, "frontend");
    expect(session).toBeNull();
  });

  it("lists active sessions", async () => {
    // Add a second session
    await createSession({ projectId, role: "frontend", model: "sonnet" });

    const sessions = await getActiveSessions(projectId);
    expect(sessions.length).toBe(2);
    expect(sessions.map((s) => s.role).sort()).toEqual(["backend", "frontend"]);
  });

  it("lists all active sessions without project filter", async () => {
    const sessions = await getActiveSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(2);
  });

  it("terminates a session", async () => {
    await terminateSession(sessionId);
    const session = await getSession(sessionId);
    expect(session!.status).toBe("terminated");
    expect(session!.finishedAt).not.toBeNull();
  });

  it("terminated session not in active list", async () => {
    const sessions = await getActiveSessions(projectId);
    expect(sessions.find((s) => s.id === sessionId)).toBeUndefined();
  });

  it("gets last session for role (even terminated)", async () => {
    const session = await getLastSessionForRole(projectId, "backend");
    expect(session).not.toBeNull();
    expect(session!.id).toBe(sessionId);
  });
});
