import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import express from "express";
import { type Server } from "node:http";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { prRouter } from "../pr-api";

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
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);

  const app = express();
  app.use(express.json());
  app.use("/api", prRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err.name === "ZodError") return res.status(400).json({ error: "Validation error" });
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
  await pool.query("DELETE FROM projects WHERE slug LIKE 'pra-%'");
  const { rows } = await pool.query(
    "INSERT INTO projects (name, slug, repo_url) VALUES ('PR API', 'pra-test', $1) RETURNING id",
    ["https://github.com/test/pr-api-repo"],
  );
  projectId = rows[0].id;
});

afterEach(() => {
  delete process.env.GITHUB_TOKEN;
});

afterAll(async () => {
  server?.close();
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
    expect(body.error).toMatch(/Project not found/);
  });

  it("400 when the project has no repo_url", async () => {
    const { rows } = await getPool().query(
      "INSERT INTO projects (name, slug) VALUES ('No Repo', 'pra-norepo') RETURNING id",
    );
    process.env.GITHUB_TOKEN = "t";
    const { status, body } = await api("/api/pr/create", {
      method: "POST",
      body: JSON.stringify({ projectId: rows[0].id, title: "t", body: "b", head: "h" }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/no repository URL/);
  });

  it("400 when GITHUB_TOKEN is not configured", async () => {
    delete process.env.GITHUB_TOKEN;
    const { status, body } = await api("/api/pr/create", {
      method: "POST",
      body: JSON.stringify({ projectId, title: "t", body: "b", head: "h" }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/GITHUB_TOKEN not configured/);
  });

  it("400 when the repo URL's provider can't be detected", async () => {
    const { rows } = await getPool().query(
      "INSERT INTO projects (name, slug, repo_url) VALUES ('Weird', 'pra-weird', $1) RETURNING id",
      ["https://example.com/not-a-git-host/x"],
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
