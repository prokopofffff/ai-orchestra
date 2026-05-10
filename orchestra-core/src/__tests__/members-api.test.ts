import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { membersPlugin } from "../members-api";
import { taskPlugin } from "../task-api";
import { setupTestUser, getOrCreateTestUser } from "./helpers/test-auth";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let ownerId: string;
let outsiderId: string;
let projectId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  const pool = getPool();
  ownerId = await getOrCreateTestUser("members-owner@orchestra.local");
  outsiderId = await getOrCreateTestUser("members-outsider@orchestra.local");
  await pool.query("DELETE FROM project_members");
  await pool.query("DELETE FROM projects WHERE slug = 'members-test'");
  const { rows } = await pool.query(
    "INSERT INTO projects (name, slug, owner_id) VALUES ('Members Test', 'members-test', $1) RETURNING id",
    [ownerId],
  );
  projectId = rows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

async function buildApp(email: string): Promise<FastifyInstance> {
  const app = Fastify();
  await setupTestUser(app, email);
  await app.register(membersPlugin);
  await app.register(taskPlugin); // for cross-checks (e.g. /projects)
  await app.ready();
  return app;
}

describe("members-api — list", () => {
  it("returns owner + members for a project the user belongs to", async () => {
    await getPool().query(
      "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')",
      [projectId, outsiderId],
    );

    const app = await buildApp("members-owner@orchestra.local");
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/members` });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.owner.userId).toBe(ownerId);
    expect(body.owner.role).toBe("owner");
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).toMatchObject({ userId: outsiderId, role: "editor" });
  });

  it("404s when caller has no access", async () => {
    const app = await buildApp("members-outsider@orchestra.local");
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/members` });
    await app.close();
    expect(res.statusCode).toBe(404);
  });
});

describe("members-api — invite", () => {
  it("owner can invite by email; new member sees the project", async () => {
    const app = await buildApp("members-owner@orchestra.local");
    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/members`,
      payload: { identifier: "members-outsider@orchestra.local", role: "editor" },
    });
    await app.close();

    expect(res.statusCode).toBe(201);

    // Outsider can now list the project — proves the membership is live.
    const app2 = await buildApp("members-outsider@orchestra.local");
    const list = await app2.inject({ method: "GET", url: "/projects" });
    await app2.close();
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].id).toBe(projectId);
  });

  it("invite by username also works", async () => {
    const app = await buildApp("members-owner@orchestra.local");
    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/members`,
      payload: { identifier: "membersoutsider", role: "viewer" },
    });
    await app.close();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ role: "viewer" });
  });

  it("non-owner / non-admin members can't invite", async () => {
    await getPool().query(
      "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')",
      [projectId, outsiderId],
    );

    const app = await buildApp("members-outsider@orchestra.local");
    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/members`,
      payload: { identifier: "members-owner@orchestra.local", role: "editor" },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  it("404 on unknown user", async () => {
    const app = await buildApp("members-owner@orchestra.local");
    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/members`,
      payload: { identifier: "ghost@nowhere", role: "editor" },
    });
    await app.close();
    expect(res.statusCode).toBe(404);
  });

  it("rejects inviting the owner", async () => {
    const app = await buildApp("members-owner@orchestra.local");
    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/members`,
      payload: { identifier: "members-owner@orchestra.local", role: "admin" },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
  });
});

describe("members-api — change role", () => {
  it("owner can promote a member", async () => {
    await getPool().query(
      "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'viewer')",
      [projectId, outsiderId],
    );

    const app = await buildApp("members-owner@orchestra.local");
    const res = await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/members/${outsiderId}`,
      payload: { role: "admin" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe("admin");
  });
});

describe("members-api — remove", () => {
  it("owner can remove a member", async () => {
    await getPool().query(
      "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')",
      [projectId, outsiderId],
    );

    const app = await buildApp("members-owner@orchestra.local");
    const res = await app.inject({
      method: "DELETE",
      url: `/projects/${projectId}/members/${outsiderId}`,
    });
    await app.close();
    expect(res.statusCode).toBe(200);

    // Removed user no longer sees the project
    const app2 = await buildApp("members-outsider@orchestra.local");
    const list = await app2.inject({ method: "GET", url: "/projects" });
    await app2.close();
    expect(list.json()).toHaveLength(0);
  });

  it("members can self-leave", async () => {
    await getPool().query(
      "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')",
      [projectId, outsiderId],
    );

    const app = await buildApp("members-outsider@orchestra.local");
    const res = await app.inject({
      method: "DELETE",
      url: `/projects/${projectId}/members/${outsiderId}`,
    });
    await app.close();
    expect(res.statusCode).toBe(200);
  });

  it("non-admin can't remove someone else", async () => {
    const otherUserId = await getOrCreateTestUser("members-3rd@orchestra.local");
    await getPool().query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES
        ($1, $2, 'editor'),
        ($1, $3, 'editor')`,
      [projectId, outsiderId, otherUserId],
    );

    const app = await buildApp("members-outsider@orchestra.local");
    const res = await app.inject({
      method: "DELETE",
      url: `/projects/${projectId}/members/${otherUserId}`,
    });
    await app.close();
    expect(res.statusCode).toBe(403);
  });
});
