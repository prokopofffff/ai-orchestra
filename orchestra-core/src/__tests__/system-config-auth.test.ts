import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { taskPlugin } from "../task-api";
import { setupTestUser, getOrCreateTestUser } from "./helpers/test-auth";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let adminEmail: string;
let outsiderEmail: string;

async function buildApp(email: string): Promise<FastifyInstance> {
  const app = Fastify();
  await setupTestUser(app, email);
  await app.register(taskPlugin);
  await app.ready();
  return app;
}

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);

  const pool = getPool();
  // The instance admin is the earliest-registered user. New users are always
  // inserted with a later created_at, so whoever is earliest now stays earliest
  // — read it and treat that account as admin.
  const { rows } = await pool.query("SELECT email FROM users ORDER BY created_at ASC, id ASC LIMIT 1");
  adminEmail = (rows[0]?.email as string | undefined)
    ?? (await (async () => {
      await getOrCreateTestUser("syscfg-admin@orchestra.local");
      const { rows: r } = await pool.query("SELECT email FROM users ORDER BY created_at ASC, id ASC LIMIT 1");
      return r[0].email as string;
    })());

  // A freshly created user — guaranteed not to be the earliest.
  outsiderEmail = "syscfg-outsider@orchestra.local";
  await getOrCreateTestUser(outsiderEmail);

  const adminId = await getOrCreateTestUser(adminEmail);
  const outsiderId = await getOrCreateTestUser(outsiderEmail);
  expect(outsiderId).not.toBe(adminId); // sanity: outsider is not the admin
});

afterAll(async () => {
  await getPool().end();
});

describe("system-config — instance-admin gate", () => {
  it("lets the instance admin read system config", async () => {
    const app = await buildApp(adminEmail);
    const res = await app.inject({ method: "GET", url: "/system-config" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a non-admin reading system config", async () => {
    const app = await buildApp(outsiderEmail);
    const res = await app.inject({ method: "GET", url: "/system-config" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects a non-admin writing system config", async () => {
    const app = await buildApp(outsiderEmail);
    const res = await app.inject({
      method: "PATCH",
      url: "/system-config",
      payload: { claude_auth: "api" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("lets the instance admin write system config", async () => {
    const app = await buildApp(adminEmail);
    const res = await app.inject({
      method: "PATCH",
      url: "/system-config",
      payload: { github_default_branch: "main" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
