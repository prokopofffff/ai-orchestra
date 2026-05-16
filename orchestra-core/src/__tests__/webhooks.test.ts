import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyError, type FastifyRequest, type FastifyReply } from "fastify";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { webhookPlugin } from "../webhooks";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let app: ReturnType<typeof Fastify>;
let baseUrl: string;
let projectId: string;

async function api(path: string, options?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);

  app = Fastify();
  await app.register(webhookPlugin, { prefix: "/api" });
  app.setErrorHandler(async (err: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(500).send({ error: err.message });
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = address;
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM telegram_users");
  await pool.query("DELETE FROM flow_audit");
  await pool.query("DELETE FROM signals");
  await pool.query("DELETE FROM graphile_worker._private_jobs").catch(() => {});
  await pool.query("DELETE FROM sessions");
  await pool.query("DELETE FROM task_comments");
  await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM conversations");
  await pool.query("DELETE FROM projects");

  const { rows } = await pool.query(
    "INSERT INTO projects (name, slug, repo_url) VALUES ('WH Test', 'wh-test', 'https://github.com/test/wh') RETURNING id",
  );
  projectId = rows[0].id;
  await pool.query("INSERT INTO conversations (project_id) VALUES ($1)", [projectId]);
});

afterAll(async () => {
  await app?.close();
  await getPool().end();
});

// Telegram webhook endpoint was removed in the per-project rewrite —
// each project now has its own bot token and runs its own polling loop
// through telegram-manager. The webhook tests that used to live here
// don't have a global URL to call any more.

describe("GitHub webhook", () => {
  it("stores PR opened as system message", async () => {
    const { status } = await api("/api/git/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "pull_request",
      } as Record<string, string>,
      body: JSON.stringify({
        action: "opened",
        repository: { html_url: "https://github.com/test/wh" },
        pull_request: { title: "Add auth", html_url: "https://github.com/test/wh/pull/1" },
      }),
    });
    expect(status).toBe(200);

    const { rows } = await getPool().query(
      `SELECT m.text, m.from_role FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.project_id = $1`,
      [projectId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].text).toContain("PR opened");
    expect(rows[0].from_role).toBe("system");
  });

  it("stores push event as system message", async () => {
    await api("/api/git/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
      } as Record<string, string>,
      body: JSON.stringify({
        ref: "refs/heads/main",
        repository: { html_url: "https://github.com/test/wh" },
        commits: [{ id: "abc" }, { id: "def" }],
      }),
    });

    const { rows } = await getPool().query(
      `SELECT m.text FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.project_id = $1`,
      [projectId],
    );
    expect(rows.some((r) => (r.text as string).includes("Push to main: 2 commit(s)"))).toBe(true);
  });

  it("ignores unknown repo", async () => {
    const { status } = await api("/api/git/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
      } as Record<string, string>,
      body: JSON.stringify({
        ref: "refs/heads/main",
        repository: { html_url: "https://github.com/unknown/repo" },
        commits: [],
      }),
    });
    expect(status).toBe(200);
  });
});
