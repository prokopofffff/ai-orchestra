import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { onboardingPlugin } from "../onboarding-api";
import { setupTestUser, getOrCreateTestUser } from "./helpers/test-auth";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let userId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM project_members");
  await pool.query("DELETE FROM projects WHERE slug LIKE 'onb-%'");
  await pool.query("DELETE FROM system_config");
  await pool.query("DELETE FROM users WHERE email = 'onb-test@orchestra.local'");
  userId = await getOrCreateTestUser("onb-test@orchestra.local");
});

afterEach(() => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITLAB_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_API_KEY;
});

afterAll(async () => {
  await getPool().end();
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await setupTestUser(app, "onb-test@orchestra.local");
  await app.register(onboardingPlugin, { prefix: "/api" });
  await app.ready();
  return app;
}

describe("onboarding — fresh user", () => {
  it("shows the welcome screen and core steps unchecked", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/onboarding" });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.showWelcome).toBe(true);
    expect(body.dismissedAt).toBeNull();
    expect(body.allDone).toBe(false);
    expect(body.steps).toHaveLength(4);
    // None of the steps should pre-tick for a fresh signup, even when the
    // orchestra-wide system_config or env has Claude / GitHub credentials
    // from a previous user — those don't count as "this user did
    // something". All four steps stay unchecked until the user creates
    // their first project.
    const map = Object.fromEntries((body.steps as { key: string; done: boolean }[]).map((s) => [s.key, s.done]));
    expect(map.claude_auth).toBe(false);
    expect(map.project).toBe(false);
    expect(map.git_token).toBe(false);
    expect(map.telegram).toBe(false);
  });

  it("stays at 0-of-4 even when system_config + env are pre-populated", async () => {
    // Seed every "orchestra-wide" knob a previous user might have set.
    await getPool().query("INSERT INTO system_config (key, value) VALUES ('claude_auth', 'max')");
    await getPool().query("INSERT INTO system_config (key, value) VALUES ('claude_api_key', 'sk-test')");
    await getPool().query("INSERT INTO system_config (key, value) VALUES ('github_token', 'ghp_test')");
    process.env.ANTHROPIC_API_KEY = "sk-test-env";
    process.env.GITHUB_TOKEN = "ghp_env";

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/onboarding" });
    await app.close();

    const body = res.json();
    const map = Object.fromEntries((body.steps as { key: string; done: boolean }[]).map((s) => [s.key, s.done]));
    expect(map.claude_auth).toBe(false);
    expect(map.project).toBe(false);
    expect(map.git_token).toBe(false);
    expect(map.telegram).toBe(false);
  });
});

describe("onboarding — live step computation", () => {
  it("does NOT tick claude_auth before the user has a project (avoid pre-ticking new signups)", async () => {
    await getPool().query(
      "INSERT INTO system_config (key, value) VALUES ('claude_auth', 'max')",
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/onboarding" });
    await app.close();
    const claude = (res.json().steps as { key: string; done: boolean }[]).find((s) => s.key === "claude_auth");
    expect(claude?.done).toBe(false);
  });

  it("ticks claude_auth once the user has a project AND system_config has the row", async () => {
    await getPool().query(
      "INSERT INTO system_config (key, value) VALUES ('claude_auth', 'max')",
    );
    await getPool().query(
      "INSERT INTO projects (name, slug, owner_id, local_path) VALUES ('P', 'onb-claude', $1, '/tmp/repo')",
      [userId],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/onboarding" });
    await app.close();
    const claude = (res.json().steps as { key: string; done: boolean }[]).find((s) => s.key === "claude_auth");
    expect(claude?.done).toBe(true);
  });

  it("ticks claude_auth when user has a project AND ANTHROPIC_API_KEY env var is present", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    await getPool().query(
      "INSERT INTO projects (name, slug, owner_id, local_path) VALUES ('P', 'onb-claude2', $1, '/tmp/repo')",
      [userId],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/onboarding" });
    await app.close();
    const claude = (res.json().steps as { key: string; done: boolean }[]).find((s) => s.key === "claude_auth");
    expect(claude?.done).toBe(true);
  });

  it("ticks project step once a project is owned", async () => {
    await getPool().query(
      "INSERT INTO projects (name, slug, owner_id, repo_url) VALUES ('P', 'onb-p', $1, 'https://github.com/x/y')",
      [userId],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/onboarding" });
    await app.close();
    const proj = (res.json().steps as { key: string; done: boolean }[]).find((s) => s.key === "project");
    expect(proj?.done).toBe(true);
  });

  it("ticks project step when user is a member of someone else's project", async () => {
    const otherUser = await getOrCreateTestUser("onb-owner@orchestra.local");
    const { rows } = await getPool().query(
      "INSERT INTO projects (name, slug, owner_id, repo_url) VALUES ('P2', 'onb-p2', $1, 'https://github.com/x/y') RETURNING id",
      [otherUser],
    );
    await getPool().query(
      "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')",
      [rows[0].id, userId],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/onboarding" });
    await app.close();
    const proj = (res.json().steps as { key: string; done: boolean }[]).find((s) => s.key === "project");
    expect(proj?.done).toBe(true);
  });

  it("ticks git_token automatically when all projects use local_path", async () => {
    await getPool().query(
      "INSERT INTO projects (name, slug, owner_id, local_path) VALUES ('Local', 'onb-local', $1, '/tmp/repo')",
      [userId],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/onboarding" });
    await app.close();
    const git = (res.json().steps as { key: string; done: boolean }[]).find((s) => s.key === "git_token");
    expect(git?.done).toBe(true);
  });

  it("re-opens git_token when a remote-repo project exists without a token", async () => {
    await getPool().query(
      "INSERT INTO projects (name, slug, owner_id, repo_url) VALUES ('Rem', 'onb-rem', $1, 'https://github.com/x/y')",
      [userId],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/onboarding" });
    await app.close();
    const git = (res.json().steps as { key: string; done: boolean }[]).find((s) => s.key === "git_token");
    expect(git?.done).toBe(false);
  });

  it("ticks git_token when project settings carry a provider token", async () => {
    await getPool().query(
      `INSERT INTO projects (name, slug, owner_id, repo_url, settings)
       VALUES ('Rem', 'onb-rem2', $1, 'https://github.com/x/y',
               '{"provider":{"token":"ghp_x"}}'::jsonb)`,
      [userId],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/onboarding" });
    await app.close();
    const git = (res.json().steps as { key: string; done: boolean }[]).find((s) => s.key === "git_token");
    expect(git?.done).toBe(true);
  });
});

describe("onboarding — dismiss", () => {
  it("POST /api/onboarding/dismiss sets the timestamp and stops welcome from showing", async () => {
    const app = await buildApp();
    const before = await app.inject({ method: "GET", url: "/api/onboarding" });
    expect(before.json().showWelcome).toBe(true);

    const dismiss = await app.inject({ method: "POST", url: "/api/onboarding/dismiss" });
    expect(dismiss.statusCode).toBe(200);
    expect(dismiss.json().showWelcome).toBe(false);
    expect(dismiss.json().dismissedAt).toBeTruthy();

    const after = await app.inject({ method: "GET", url: "/api/onboarding" });
    expect(after.json().showWelcome).toBe(false);
    await app.close();
  });

  it("POST /api/onboarding/welcome-seen hides the welcome without touching the checklist", async () => {
    const app = await buildApp();
    const before = await app.inject({ method: "GET", url: "/api/onboarding" });
    expect(before.json().showWelcome).toBe(true);
    expect(before.json().dismissedAt).toBeNull();

    const mark = await app.inject({ method: "POST", url: "/api/onboarding/welcome-seen" });
    expect(mark.statusCode).toBe(200);
    expect(mark.json().showWelcome).toBe(false);
    expect(mark.json().welcomeSeenAt).toBeTruthy();
    // Checklist itself is NOT dismissed — that's a separate user action.
    expect(mark.json().dismissedAt).toBeNull();

    // Survives a reload (re-fetch).
    const after = await app.inject({ method: "GET", url: "/api/onboarding" });
    expect(after.json().showWelcome).toBe(false);
    expect(after.json().dismissedAt).toBeNull();
    await app.close();
  });

  it("welcome doesn't show for a returning user who already has a project", async () => {
    // No dismissal, but they've already created a project — they're not
    // a fresh signup, no need to flash the modal at them.
    await getPool().query(
      "INSERT INTO projects (name, slug, owner_id, repo_url) VALUES ('P', 'onb-back', $1, 'https://github.com/x/y')",
      [userId],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/onboarding" });
    await app.close();
    expect(res.json().showWelcome).toBe(false);
  });
});

describe("onboarding — per-tab tours", () => {
  it("fresh user has empty tabsSeen", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/onboarding" });
    await app.close();
    expect(res.json().tabsSeen).toEqual([]);
  });

  it("POST /onboarding/tabs/:key appends idempotently", async () => {
    const app = await buildApp();
    const a = await app.inject({ method: "POST", url: "/api/onboarding/tabs/kanban" });
    expect(a.statusCode).toBe(200);
    expect(a.json().tabsSeen).toEqual(["kanban"]);

    const b = await app.inject({ method: "POST", url: "/api/onboarding/tabs/chat" });
    expect(b.json().tabsSeen).toEqual(["kanban", "chat"]);

    // Re-post same key — no duplicate.
    const c = await app.inject({ method: "POST", url: "/api/onboarding/tabs/kanban" });
    expect(c.json().tabsSeen).toEqual(["kanban", "chat"]);
    await app.close();
  });

  it("rejects unknown tab keys", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/onboarding/tabs/not-a-real-tab" });
    await app.close();
    expect(res.statusCode).toBe(400);
  });
});

describe("onboarding — allDone", () => {
  it("flips when every step is satisfied", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    await getPool().query(
      "INSERT INTO projects (name, slug, owner_id, local_path) VALUES ('Local', 'onb-all', $1, '/tmp/repo')",
      [userId],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/onboarding" });
    await app.close();
    expect(res.json().allDone).toBe(true);
  });
});
