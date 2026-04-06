import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { type Server } from "node:http";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { webhookRouter } from "../webhooks";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let server: Server;
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

  const app = express();
  app.use(express.json());
  app.use("/api", webhookRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM telegram_users");
  await pool.query("DELETE FROM flow_audit");
  await pool.query("DELETE FROM signals");
  await pool.query("DELETE FROM task_queue");
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
  server?.close();
  await getPool().end();
});

describe("Telegram webhook", () => {
  it("stores user message in conversation (auto-select single project)", async () => {
    const { status } = await api("/api/telegram/webhook", {
      method: "POST",
      body: JSON.stringify({
        message: { chat: { id: 12345 }, text: "Hello from TG", message_id: 1 },
      }),
    });
    expect(status).toBe(200);

    // Check message stored
    const { rows } = await getPool().query(
      `SELECT m.* FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.project_id = $1`,
      [projectId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].text).toBe("Hello from TG");
    expect(rows[0].source).toBe("telegram");
    expect(rows[0].from_role).toBe("user");
  });

  it("ignores messages without text", async () => {
    const { status } = await api("/api/telegram/webhook", {
      method: "POST",
      body: JSON.stringify({
        message: { chat: { id: 12345 } },
      }),
    });
    expect(status).toBe(200);
  });

  it("handles /start command", async () => {
    const { status } = await api("/api/telegram/webhook", {
      method: "POST",
      body: JSON.stringify({
        message: { chat: { id: 12345 }, text: "/start", message_id: 1 },
      }),
    });
    expect(status).toBe(200);
    // Command doesn't store a message in conversation
  });

  it("handles /switch command", async () => {
    const { status } = await api("/api/telegram/webhook", {
      method: "POST",
      body: JSON.stringify({
        message: { chat: { id: 99999 }, text: "/switch wh-test", message_id: 1 },
      }),
    });
    expect(status).toBe(200);

    // Check active project set
    const { rows } = await getPool().query(
      "SELECT active_project_id FROM telegram_users WHERE chat_id = '99999'",
    );
    expect(rows.length).toBe(1);
    expect(rows[0].active_project_id).toBe(projectId);
  });

  it("uses active project for subsequent messages", async () => {
    // Set active project
    await getPool().query(
      "INSERT INTO telegram_users (chat_id, active_project_id) VALUES ('77777', $1)",
      [projectId],
    );

    const { status } = await api("/api/telegram/webhook", {
      method: "POST",
      body: JSON.stringify({
        message: { chat: { id: 77777 }, text: "Working on auth", message_id: 2 },
      }),
    });
    expect(status).toBe(200);

    const { rows } = await getPool().query(
      `SELECT m.text FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.project_id = $1`,
      [projectId],
    );
    expect(rows.some((r) => r.text === "Working on auth")).toBe(true);
  });
});

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
