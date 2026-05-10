import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyError, type FastifyRequest, type FastifyReply } from "fastify";
import { taskPlugin } from "../task-api";
import { signalPlugin } from "../signal-api";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { setupTestUser } from "./helpers/test-auth";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let app: ReturnType<typeof Fastify>;
let baseUrl: string;

async function api(path: string, options?: RequestInit) {
  const headers: Record<string, string> = {};
  // Only set Content-Type for methods that carry a body — Fastify rejects
  // Content-Type: application/json on bodyless DELETE requests.
  if (options?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${path}`, { headers, ...options });
  const body = await res.json();
  return { status: res.status, body };
}

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);

  // Clean tables for test isolation
  const pool = getPool();
  await pool.query("DELETE FROM flow_audit");
  await pool.query("DELETE FROM signals");
  await pool.query("DELETE FROM task_comments");
  await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM conversations");
  await pool.query("DELETE FROM projects");
  await pool.query("DELETE FROM users WHERE email = 'integration-test@orchestra.local'");

  app = Fastify();
  await setupTestUser(app, "integration-test@orchestra.local");
  await app.register(taskPlugin, { prefix: "/api" });
  await app.register(signalPlugin, { prefix: "/api" });

  // Error handler (same as index.ts)
  app.setErrorHandler(async (err: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    if (err.name === "ZodError") {
      return reply.code(400).send({ error: "Validation error", details: err });
    }
    return reply.code(500).send({ error: err.message });
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = address;
});

afterAll(async () => {
  await app?.close();
  await getPool().end();
});

// ─── Projects ───

describe("Task API — Projects", () => {
  let projectId: string;

  it("POST /api/projects — creates a project", async () => {
    const { status, body } = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "My App", repoUrl: "https://github.com/org/repo" }),
    });
    expect(status).toBe(201);
    expect(body.name).toBe("My App");
    expect(body.slug).toBe("my-app");
    expect(body.repoUrl).toBe("https://github.com/org/repo");
    expect(body.id).toBeDefined();
    projectId = body.id;
  });

  it("GET /api/projects — lists projects", async () => {
    const { status, body } = await api("/api/projects");
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.find((p: { id: string }) => p.id === projectId)).toBeDefined();
  });

  it("GET /api/projects/:id — returns single project", async () => {
    const { status, body } = await api(`/api/projects/${projectId}`);
    expect(status).toBe(200);
    expect(body.name).toBe("My App");
  });

  it("GET /api/projects/:id — 404 for unknown id", async () => {
    const { status } = await api("/api/projects/00000000-0000-0000-0000-000000000000");
    expect(status).toBe(404);
  });

  it("PATCH /api/projects/:id — updates project", async () => {
    const { status, body } = await api(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "A test app" }),
    });
    expect(status).toBe(200);
    expect(body.description).toBe("A test app");
  });

  it("PATCH /api/projects/:id — merges settings", async () => {
    const { body } = await api(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify({ settings: { models: { "tech-lead": "haiku" } } }),
    });
    expect(body.settings.models["tech-lead"]).toBe("haiku");
  });

  it("POST /api/projects — rejects duplicate slug", async () => {
    const { status } = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "My App" }),
    });
    expect(status).toBe(500); // unique constraint violation
  });
});

// ─── Tasks ───

describe("Task API — Tasks", () => {
  let projectId: string;
  let taskId: string;
  let blockerTaskId: string;

  beforeAll(async () => {
    const { body } = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Task Test Project" }),
    });
    projectId = body.id;
  });

  it("POST /api/tasks — creates a task", async () => {
    const { status, body } = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        title: "Auth API",
        type: "task",
        priority: "high",
        assigneeRole: "backend",
      }),
    });
    expect(status).toBe(201);
    expect(body.title).toBe("Auth API");
    expect(body.state).toBe("new");
    expect(body.priority).toBe("high");
    expect(body.assigneeRole).toBe("backend");
    expect(body.blockedBy).toEqual([]);
    blockerTaskId = body.id;
  });

  it("POST /api/tasks — creates a blocked task", async () => {
    const { status, body } = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        title: "Auth UI",
        type: "task",
        assigneeRole: "frontend",
        blockedBy: [blockerTaskId],
      }),
    });
    expect(status).toBe(201);
    expect(body.blockedBy).toEqual([blockerTaskId]);
    taskId = body.id;
  });

  it("GET /api/tasks — lists all tasks", async () => {
    const { body } = await api(`/api/tasks?projectId=${projectId}`);
    expect(body.length).toBe(2);
  });

  it("GET /api/tasks — filters by state", async () => {
    const { body } = await api(`/api/tasks?projectId=${projectId}&state=new`);
    expect(body.length).toBe(2);
  });

  it("GET /api/tasks — filters by assigneeRole", async () => {
    const { body } = await api(`/api/tasks?assigneeRole=frontend`);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.every((t: { assigneeRole: string }) => t.assigneeRole === "frontend")).toBe(true);
  });

  it("GET /api/tasks/:id — returns single task", async () => {
    const { status, body } = await api(`/api/tasks/${taskId}`);
    expect(status).toBe(200);
    expect(body.title).toBe("Auth UI");
  });

  it("PATCH /api/tasks/:id — updates task fields", async () => {
    const { body } = await api(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ priority: "immediate", description: "Login page" }),
    });
    expect(body.priority).toBe("immediate");
    expect(body.description).toBe("Login page");
  });

  it("PATCH /api/tasks/:id — updates state", async () => {
    const { body } = await api(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "described" }),
    });
    expect(body.state).toBe("described");
  });

  it("DELETE /api/tasks/:id — deletes task", async () => {
    // Create a throwaway task
    const { body: tmp } = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ projectId, title: "To Delete" }),
    });
    const { status } = await api(`/api/tasks/${tmp.id}`, { method: "DELETE" });
    expect(status).toBe(200);
    const { status: s2 } = await api(`/api/tasks/${tmp.id}`);
    expect(s2).toBe(404);
  });

  it("DELETE /api/tasks/:id — 404 for unknown task", async () => {
    const { status } = await api("/api/tasks/00000000-0000-0000-0000-000000000000", { method: "DELETE" });
    expect(status).toBe(404);
  });
});

// ─── Task Comments ───

describe("Task API — Comments", () => {
  let projectId: string;
  let taskId: string;

  beforeAll(async () => {
    const { body: proj } = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Comment Test Project" }),
    });
    projectId = proj.id;
    const { body: task } = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ projectId, title: "Task with comments" }),
    });
    taskId = task.id;
  });

  it("POST /api/tasks/:id/comments — adds a comment", async () => {
    const { status, body } = await api(`/api/tasks/${taskId}/comments`, {
      method: "POST",
      body: JSON.stringify({ author: "tech-lead", body: "Looks good" }),
    });
    expect(status).toBe(201);
    expect(body.author).toBe("tech-lead");
    expect(body.body).toBe("Looks good");
  });

  it("GET /api/tasks/:id/comments — lists comments", async () => {
    await api(`/api/tasks/${taskId}/comments`, {
      method: "POST",
      body: JSON.stringify({ author: "backend", body: "Question about auth" }),
    });
    const { body } = await api(`/api/tasks/${taskId}/comments`);
    expect(body.length).toBe(2);
    expect(body[0].author).toBe("tech-lead");
    expect(body[1].author).toBe("backend");
  });
});

// ─── Signal API + Flow Guard ───

describe("Signal API", () => {
  let projectId: string;
  let taskId: string;

  beforeAll(async () => {
    const { body: proj } = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Signal Test Project" }),
    });
    projectId = proj.id;
    const { body: task } = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ projectId, title: "Signal Task", state: "new" }),
    });
    taskId = task.id;
  });

  it("rejects invalid route (frontend → backend)", async () => {
    const { status, body } = await api("/api/signal", {
      method: "POST",
      body: JSON.stringify({ from: "frontend", to: "backend", action: "pr_created", projectId }),
    });
    expect(status).toBe(403);
    expect(body.error).toContain("Route not allowed");
  });

  it("rejects invalid action (frontend: deploy)", async () => {
    const { status, body } = await api("/api/signal", {
      method: "POST",
      body: JSON.stringify({ from: "frontend", to: "tech-lead", action: "deploy", projectId }),
    });
    expect(status).toBe(403);
    expect(body.error).toContain("Action not allowed");
  });

  it("rejects invalid state transition (new → pr_created — must go through development)", async () => {
    const { status, body } = await api("/api/signal", {
      method: "POST",
      body: JSON.stringify({ from: "backend", to: "tech-lead", action: "pr_created", projectId, taskId }),
    });
    expect(status).toBe(403);
    expect(body.error).toContain("Invalid transition");
  });

  it("accepts valid signal and updates task state", async () => {
    // Move task to described first
    await api(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "described" }),
    });

    // assign_dev: described → in_development
    const { status, body } = await api("/api/signal", {
      method: "POST",
      body: JSON.stringify({ from: "tech-lead", to: "backend", action: "assign_dev", projectId, taskId }),
    });
    expect(status).toBe(201);
    expect(body.status).toBe("accepted");

    // Verify task state changed
    const { body: task } = await api(`/api/tasks/${taskId}`);
    expect(task.state).toBe("in_development");
  });

  it("accepts signal without task (no state transition check)", async () => {
    const { status, body } = await api("/api/signal", {
      method: "POST",
      body: JSON.stringify({ from: "backend", to: "tech-lead", action: "question", projectId }),
    });
    expect(status).toBe(201);
    expect(body.status).toBe("accepted");
  });

  it("continues state machine: in_development → pr_created", async () => {
    const { status } = await api("/api/signal", {
      method: "POST",
      body: JSON.stringify({ from: "backend", to: "qa", action: "pr_created", projectId, taskId }),
    });
    expect(status).toBe(201);

    const { body: task } = await api(`/api/tasks/${taskId}`);
    expect(task.state).toBe("pr_created");
  });

  // ─── Audit Log ───

  it("GET /api/flow/audit — returns audit entries", async () => {
    const { status, body } = await api(`/api/flow/audit?projectId=${projectId}`);
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThanOrEqual(3);

    const allowed = body.filter((e: { status: string }) => e.status === "allowed");
    const rejected = body.filter((e: { status: string }) => e.status === "rejected");
    expect(allowed.length).toBeGreaterThanOrEqual(1);
    expect(rejected.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/flow/violations — returns only rejected", async () => {
    const { status, body } = await api(`/api/flow/violations?projectId=${projectId}`);
    expect(status).toBe(200);
    expect(body.every((e: { status: string }) => e.status === "rejected")).toBe(true);
  });

  // ─── Pending Signals ───

  it("GET /api/signals — lists signals", async () => {
    const { status, body } = await api(`/api/signals?projectId=${projectId}`);
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/signals — filters by toRole", async () => {
    const { body } = await api(`/api/signals?projectId=${projectId}&toRole=tech-lead`);
    expect(body.every((s: { to_role: string }) => s.to_role === "tech-lead")).toBe(true);
  });
});
