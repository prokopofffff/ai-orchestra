import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fsPlugin } from "../fs-api";
import { setupTestUser } from "./helpers/test-auth";
import { waitForDatabase, runMigrations, getPool } from "../db";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

// Per-user workspace scope test setup. FolderPicker now refuses paths
// outside ORCHESTRA_WORKSPACES_ROOT/<userId>/, so the fixture tree lives
// inside `<workspacesRoot>/<testUserId>/` and we surface that as `tmpDir`
// so the assertions below stay readable.
let workspacesRoot: string;
let userId: string;
let tmpDir: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
  workspacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fs-api-root-"));
  process.env.ORCHESTRA_WORKSPACES_ROOT = workspacesRoot;

  // setupTestUser returns the user id we need for the scope dir.
  const probe = Fastify();
  userId = await setupTestUser(probe, "fs-test@orchestra.local");
  await probe.close();

  tmpDir = path.join(workspacesRoot, userId);
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(path.join(tmpDir, "alpha"));
  await fs.mkdir(path.join(tmpDir, "beta"));
  await fs.mkdir(path.join(tmpDir, ".hidden"));
  await fs.mkdir(path.join(tmpDir, "with-repo"));
  await fs.mkdir(path.join(tmpDir, "with-repo", ".git"));
  await fs.writeFile(path.join(tmpDir, "loose-file.txt"), "x");
});

afterAll(async () => {
  await fs.rm(workspacesRoot, { recursive: true, force: true });
  delete process.env.ORCHESTRA_WORKSPACES_ROOT;
  await getPool().end();
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await setupTestUser(app, "fs-test@orchestra.local");
  await app.register(fsPlugin, { prefix: "/api" });
  await app.ready();
  return app;
}

describe("GET /api/fs/browse", () => {
  it("lists subdirectories of the given path, excluding files and hidden by default", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/fs/browse?path=${encodeURIComponent(tmpDir)}` });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cwd).toBe(tmpDir);
    const names = (body.entries as { name: string }[]).map((e) => e.name);
    expect(names).toEqual(["alpha", "beta", "with-repo"]);
  });

  it("returns isGitRepo=true for folders containing a .git entry", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/fs/browse?path=${encodeURIComponent(tmpDir)}` });
    await app.close();
    const entries = res.json().entries as { name: string; isGitRepo: boolean }[];
    expect(entries.find((e) => e.name === "with-repo")?.isGitRepo).toBe(true);
    expect(entries.find((e) => e.name === "alpha")?.isGitRepo).toBe(false);
  });

  it("includes hidden entries when showHidden=true", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/fs/browse?path=${encodeURIComponent(tmpDir)}&showHidden=true`,
    });
    await app.close();
    const names = (res.json().entries as { name: string }[]).map((e) => e.name);
    expect(names).toContain(".hidden");
  });

  it("returns null parent + scope as home at the user's scope root", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/fs/browse?path=${encodeURIComponent(tmpDir)}` });
    await app.close();
    const body = res.json();
    // tmpDir IS the user scope root — parent is null so the UI can hide
    // the "up" button instead of letting the user navigate above it.
    expect(body.parent).toBeNull();
    expect(body.home).toBe(tmpDir);
  });

  it("defaults to the user's scope dir when no path is given", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/fs/browse" });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().cwd).toBe(tmpDir);
  });

  it("403 when the requested path is outside the user's scope", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/fs/browse?path=${encodeURIComponent(os.tmpdir())}` });
    await app.close();
    expect(res.statusCode).toBe(403);
  });

  it("404 for a non-existent path", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/fs/browse?path=${encodeURIComponent(path.join(tmpDir, "no-such-dir"))}`,
    });
    await app.close();
    expect(res.statusCode).toBe(404);
  });

  it("400 when path points at a file", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/fs/browse?path=${encodeURIComponent(path.join(tmpDir, "loose-file.txt"))}`,
    });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it("403 at the filesystem root (outside the user's scope)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/fs/browse?path=${encodeURIComponent("/")}` });
    await app.close();
    expect(res.statusCode).toBe(403);
  });
});
