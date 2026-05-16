import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import Fastify from "fastify";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { bindChatToProject } from "../telegram-manager";
import { getProjectTelegram } from "../notification-hub";
import { setupTestUser } from "./helpers/test-auth";

// Stub the reconcile function used by PATCH /projects so saving a token
// doesn't spawn a real getUpdates loop against api.telegram.org.
vi.mock("../telegram-manager", async () => {
  const actual = await vi.importActual<typeof import("../telegram-manager")>("../telegram-manager");
  return {
    ...actual,
    reconcileTelegramNow: vi.fn(async () => { /* no-op in tests */ }),
    // bindChatToProject + stopTelegramManager are still real.
  };
});

// Importing AFTER vi.mock so the mocked version is what task-api gets.
const { taskPlugin } = await import("../task-api");

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let userId: string;
let projectId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM projects WHERE slug LIKE 'tg-test%'");
  await pool.query("DELETE FROM users WHERE email = 'tg-test@orchestra.local'");
  userId = (await pool.query(
    `INSERT INTO users (email, username, password_hash)
     VALUES ('tg-test@orchestra.local', 'tgtest', 'stub') RETURNING id`,
  )).rows[0].id;
  projectId = (await pool.query(
    `INSERT INTO projects (name, slug, owner_id) VALUES ('TG Test', 'tg-test', $1) RETURNING id`,
    [userId],
  )).rows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

async function buildApp() {
  const app = Fastify();
  await setupTestUser(app, "tg-test@orchestra.local");
  await app.register(taskPlugin);
  await app.ready();
  return app;
}

describe("bindChatToProject", () => {
  it("writes chatId into settings.telegram.chatId", async () => {
    await getPool().query(
      `UPDATE projects SET settings = '{"telegram":{"botToken":"123:abc"}}'::jsonb WHERE id = $1`,
      [projectId],
    );
    await bindChatToProject(projectId, "555000");

    const tg = await getProjectTelegram(projectId);
    expect(tg).toEqual({ botToken: "123:abc", chatId: "555000" });
  });
});

describe("getProjectTelegram", () => {
  it("returns null when token or chat are missing", async () => {
    expect(await getProjectTelegram(projectId)).toBeNull();
    await getPool().query(
      `UPDATE projects SET settings = '{"telegram":{"botToken":"only-token"}}'::jsonb WHERE id = $1`,
      [projectId],
    );
    expect(await getProjectTelegram(projectId)).toBeNull();
  });
});

describe("PATCH /projects — telegram uniqueness", () => {
  it("rejects a token that's already used by another project", async () => {
    const other = (await getPool().query(
      `INSERT INTO projects (name, slug, owner_id, settings)
       VALUES ('Other', 'tg-test-other', $1, '{"telegram":{"botToken":"shared-token"}}'::jsonb)
       RETURNING id`,
      [userId],
    )).rows[0].id;

    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}`,
      payload: { settings: { telegram: { botToken: "shared-token" } } },
    });
    await app.close();

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already in use/);

    // Original owner of the token unchanged.
    const { rows } = await getPool().query(
      `SELECT settings -> 'telegram' ->> 'botToken' AS t FROM projects WHERE id = $1`,
      [other],
    );
    expect(rows[0].t).toBe("shared-token");
  });

  it("allows the same project to re-save its own token (idempotent)", async () => {
    await getPool().query(
      `UPDATE projects SET settings = '{"telegram":{"botToken":"mine"}}'::jsonb WHERE id = $1`,
      [projectId],
    );
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}`,
      payload: { settings: { telegram: { botToken: "mine" } } },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
  });
});
