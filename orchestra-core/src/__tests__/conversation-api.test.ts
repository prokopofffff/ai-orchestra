import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyError, type FastifyRequest, type FastifyReply } from "fastify";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { conversationPlugin, addSystemMessage, addTechLeadMessage } from "../conversation-api";
import { setupTestUser, getOrCreateTestUser } from "./helpers/test-auth";

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
  const body = await res.json();
  return { status: res.status, body };
}

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);

  app = Fastify();
  await setupTestUser(app, "conv-test@orchestra.local");
  await app.register(conversationPlugin, { prefix: "/api" });
  app.setErrorHandler(async (err: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(500).send({ error: err.message });
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = address;
});

beforeEach(async () => {
  const pool = getPool();
  const userId = await getOrCreateTestUser("conv-test@orchestra.local");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM conversations");
  await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM projects WHERE slug = 'conv-test'");

  const { rows } = await pool.query(
    "INSERT INTO projects (name, slug, owner_id) VALUES ('Conv Test', 'conv-test', $1) RETURNING id",
    [userId],
  );
  projectId = rows[0].id;

  await pool.query("INSERT INTO conversations (project_id) VALUES ($1)", [projectId]);
});

afterAll(async () => {
  await app?.close();
  await getPool().end();
});

describe("Conversation API", () => {
  it("POST message from user via dashboard", async () => {
    const { status, body } = await api(`/api/conversations/${projectId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Hello Tech Lead!" }),
    });
    expect(status).toBe(201);
    expect(body.fromRole).toBe("user");
    expect(body.source).toBe("dashboard");
    expect(body.text).toBe("Hello Tech Lead!");
  });

  it("GET messages returns chronological order", async () => {
    // Add 3 messages
    await api(`/api/conversations/${projectId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "First" }),
    });
    await api(`/api/conversations/${projectId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Second", fromRole: "tech-lead" }),
    });
    await api(`/api/conversations/${projectId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Third", fromRole: "system" }),
    });

    const { status, body } = await api(`/api/conversations/${projectId}/messages`);
    expect(status).toBe(200);
    expect(body.length).toBe(3);
    expect(body[0].text).toBe("First");
    expect(body[1].text).toBe("Second");
    expect(body[2].text).toBe("Third");
  });

  it("GET messages supports limit", async () => {
    for (let i = 0; i < 5; i++) {
      await api(`/api/conversations/${projectId}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: `Message ${i}` }),
      });
    }

    const { body } = await api(`/api/conversations/${projectId}/messages?limit=3`);
    expect(body.length).toBe(3);
  });

  it("returns 404 for unknown project", async () => {
    const { status } = await api("/api/conversations/00000000-0000-0000-0000-000000000000/messages");
    expect(status).toBe(404);
  });

  it("POST with telegram source", async () => {
    const { body } = await api(`/api/conversations/${projectId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "From TG", source: "telegram" }),
    });
    expect(body.source).toBe("telegram");
  });

  it("POST with metadata", async () => {
    const { body } = await api(`/api/conversations/${projectId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "With meta", metadata: { taskId: "abc" } }),
    });
    expect(body.metadata.taskId).toBe("abc");
  });
});

describe("Conversation helpers", () => {
  it("addSystemMessage creates system message", async () => {
    const msg = await addSystemMessage(projectId, "Task X → in_development");
    expect(msg).not.toBeNull();
    expect(msg!.fromRole).toBe("system");
    expect(msg!.text).toBe("Task X → in_development");
  });

  it("addTechLeadMessage creates tech-lead message", async () => {
    const msg = await addTechLeadMessage(projectId, "PR approved!");
    expect(msg).not.toBeNull();
    expect(msg!.fromRole).toBe("tech-lead");
  });

  it("returns null for non-existent project", async () => {
    const msg = await addSystemMessage("00000000-0000-0000-0000-000000000000", "test");
    expect(msg).toBeNull();
  });
});
