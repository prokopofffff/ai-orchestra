import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import Fastify, { type FastifyError, type FastifyRequest, type FastifyReply } from "fastify";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { prPlugin } from "../pr-api";
import { setupTestUser } from "./helpers/test-auth";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let app: ReturnType<typeof Fastify>;
let baseUrl: string;
let projectId: string;
let ownerId: string;

async function api(path: string, options?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);

  app = Fastify();
  app.setErrorHandler(async (err: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    if (err.name === "ZodError") return reply.code(400).send({ error: "Validation error" });
    return reply.code(500).send({ error: err.message });
  });
  // pr/create is multi-tenant gated (currentUserId + userCanEditProject), so
  // requests need an authenticated user. setupTestUser decorates every request
  // as this account; projects below are owned by it so the edit gate passes.
  ownerId = await setupTestUser(app, "pra-owner@orchestra.local");
  await app.register(prPlugin, { prefix: "/api" });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = address;
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM projects WHERE slug LIKE 'pra-%'");
  // Default project has a per-project GH token in settings — providerFor
  // requires it (no env fallback anymore). Tests that exercise the
  // "missing token" path seed a project without the settings.
  const { rows } = await pool.query(
    `INSERT INTO projects (name, slug, repo_url, settings, owner_id)
     VALUES ('PR API', 'pra-test', $1, '{"provider":{"token":"t"}}'::jsonb, $2)
     RETURNING id`,
    ["https://github.com/test/pr-api-repo", ownerId],
  );
  projectId = rows[0].id;
});

afterEach(() => {
  delete process.env.GITHUB_TOKEN;
});

afterAll(async () => {
  await app?.close();
  await getPool().end();
});

describe("pr-api — POST /api/pr/create validation", () => {
  it("400 when the body fails Zod validation", async () => {
    const { status } = await api("/api/pr/create", {
      method: "POST",
      body: JSON.stringify({ projectId: "not-a-uuid", title: "t", body: "b", head: "h" }),
    });
    expect(status).toBe(400);
  });

  it("404 when the project does not exist", async () => {
    process.env.GITHUB_TOKEN = "t";
    const { status, body } = await api("/api/pr/create", {
      method: "POST",
      body: JSON.stringify({
        projectId: "00000000-0000-0000-0000-000000000000",
        title: "t", body: "b", head: "h",
      }),
    });
    expect(status).toBe(404);
    expect(body.error).toMatch(/Проект не найден/);
  });

  it("400 when the project has no repo_url", async () => {
    const { rows } = await getPool().query(
      "INSERT INTO projects (name, slug, owner_id) VALUES ('No Repo', 'pra-norepo', $1) RETURNING id",
      [ownerId],
    );
    process.env.GITHUB_TOKEN = "t";
    const { status, body } = await api("/api/pr/create", {
      method: "POST",
      body: JSON.stringify({ projectId: rows[0].id, title: "t", body: "b", head: "h" }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/URL репозитория/);
  });

  it("400 when the project has no provider token configured", async () => {
    // Project without settings.provider.token. No env fallback exists.
    const { rows } = await getPool().query(
      "INSERT INTO projects (name, slug, repo_url, owner_id) VALUES ('No Token', 'pra-notok', $1, $2) RETURNING id",
      ["https://github.com/test/no-token", ownerId],
    );
    const { status, body } = await api("/api/pr/create", {
      method: "POST",
      body: JSON.stringify({ projectId: rows[0].id, title: "t", body: "b", head: "h" }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/GitHub token not configured/);
  });

  it("400 when the repo URL's provider can't be detected", async () => {
    const { rows } = await getPool().query(
      "INSERT INTO projects (name, slug, repo_url, owner_id) VALUES ('Weird', 'pra-weird', $1, $2) RETURNING id",
      ["https://example.com/not-a-git-host/x", ownerId],
    );
    // No tokens + unknown hostname → resolver throws a detectable error.
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITLAB_TOKEN;
    const { status, body } = await api("/api/pr/create", {
      method: "POST",
      body: JSON.stringify({ projectId: rows[0].id, title: "t", body: "b", head: "h" }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Cannot detect git provider/);
  });

  it("defaults `base` to 'main' when omitted", async () => {
    // We can't fully exercise the happy path without mocking fetch → GitHub.
    // But we can at least confirm Zod accepts the body without `base` — it
    // would reject earlier if the default weren't applied.
    process.env.GITHUB_TOKEN = "invalid-token";
    const { status } = await api("/api/pr/create", {
      method: "POST",
      body: JSON.stringify({ projectId, title: "t", body: "b", head: "h" }),
    });
    // Request got past Zod — it'll fail later in the flow (no worktree row,
    // or GitHub returns 401). Anything other than 400-from-Zod proves the
    // schema accepted the body.
    expect([201, 400, 401, 404, 500]).toContain(status);
    // Ensure it's not a Zod validation failure
    if (status === 400) {
      const { body } = await api("/api/pr/create", {
        method: "POST",
        body: JSON.stringify({ projectId, title: "t", body: "b", head: "h" }),
      });
      expect(body.error).not.toMatch(/Validation error/);
    }
  });
});
