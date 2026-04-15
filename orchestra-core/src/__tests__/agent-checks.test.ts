import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { enqueue, runOneJob } from "../scheduler";
import { CHECK_KIND } from "../agents/check-handlers";
import { agentConfigs } from "../agents/configs";
import type { AgentCheck } from "../agents/types";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let projectId: string;
let worktree: string;
const originalChecks: AgentCheck[] = [];

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);

  worktree = fs.mkdtempSync(path.join(tmpdir(), "obs-check-"));
  fs.mkdirSync(path.join(worktree, "src", "backend"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "src", "backend", "x.ts"), "export const x = 1;\n");

  // Snapshot so we can restore between tests
  originalChecks.push(...agentConfigs.backend.checks);
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM graphile_worker._private_jobs").catch(() => {});
  await pool.query("DELETE FROM signals");
  await pool.query("DELETE FROM agent_logs");
  await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM projects WHERE slug = 'obs-test'");

  const { rows } = await pool.query(
    "INSERT INTO projects (name, slug) VALUES ('Obs Test', 'obs-test') RETURNING id",
  );
  projectId = rows[0].id;

  agentConfigs.backend.checks = []; // tests set their own
});

afterAll(async () => {
  agentConfigs.backend.checks = originalChecks;
  fs.rmSync(worktree, { recursive: true, force: true });
  await getPool().end();
});

async function enqueueCheck(filePath: string): Promise<void> {
  await enqueue({
    kind: CHECK_KIND,
    payload: {
      projectId,
      sessionId: null,
      taskId: null,
      role: "backend",
      worktree,
      filePath,
    },
  });
}

describe("observe-check handler", () => {
  it("logs PASS when command exits 0", async () => {
    agentConfigs.backend.checks = [
      { name: "noop", pattern: "src/backend/**/*.ts", command: "true", onFail: "warn" },
    ];
    await enqueueCheck("src/backend/x.ts");
    await runOneJob();

    const { rows } = await getPool().query(
      "SELECT level, message FROM agent_logs WHERE project_id = $1 ORDER BY created_at",
      [projectId],
    );
    const passes = rows.filter((r) => r.message.includes("PASS"));
    expect(passes.length).toBe(1);
    expect(passes[0].level).toBe("system");
    expect(passes[0].message).toMatch(/\[check:noop\] PASS/);
  });

  it("logs FAIL (onFail=warn) without inserting a signal", async () => {
    agentConfigs.backend.checks = [
      { name: "fail-warn", pattern: "src/backend/**/*.ts", command: "false", onFail: "warn" },
    ];
    await enqueueCheck("src/backend/x.ts");
    await runOneJob();

    const { rows: logs } = await getPool().query(
      "SELECT level, message FROM agent_logs WHERE project_id = $1",
      [projectId],
    );
    expect(logs.some((r) => r.level === "error" && r.message.includes("FAIL"))).toBe(true);

    const { rows: signals } = await getPool().query(
      "SELECT * FROM signals WHERE project_id = $1",
      [projectId],
    );
    expect(signals.length).toBe(0);
  });

  it("inserts a tech-lead notify signal when onFail=alert and command fails", async () => {
    agentConfigs.backend.checks = [
      { name: "fail-alert", pattern: "src/backend/**/*.ts", command: "false", onFail: "alert" },
    ];
    await enqueueCheck("src/backend/x.ts");
    await runOneJob();

    const { rows } = await getPool().query(
      "SELECT from_role, to_role, action, payload FROM signals WHERE project_id = $1",
      [projectId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].from_role).toBe("system");
    expect(rows[0].to_role).toBe("tech-lead");
    expect(rows[0].action).toBe("notify");
    expect(rows[0].payload.message).toMatch(/fail-alert failed/);
    expect(rows[0].payload.source).toBe("observe-hook");
  });

  it("skips checks whose pattern doesn't match the file", async () => {
    agentConfigs.backend.checks = [
      { name: "frontend-only", pattern: "src/frontend/**/*.ts", command: "true", onFail: "warn" },
    ];
    await enqueueCheck("src/backend/x.ts");
    await runOneJob();

    const { rows } = await getPool().query(
      "SELECT message FROM agent_logs WHERE project_id = $1",
      [projectId],
    );
    expect(rows.some((r) => r.message.includes("frontend-only"))).toBe(false);
  });

  it("runs multiple matching checks in order", async () => {
    agentConfigs.backend.checks = [
      { name: "first",  pattern: "src/backend/**/*.ts", command: "true", onFail: "warn" },
      { name: "second", pattern: "src/backend/**/*.ts", command: "true", onFail: "warn" },
    ];
    await enqueueCheck("src/backend/x.ts");
    await runOneJob();
    // appendLog is fire-and-forget; let inserts settle before reading.
    await new Promise((r) => setTimeout(r, 100));

    const { rows } = await getPool().query(
      "SELECT message FROM agent_logs WHERE project_id = $1 ORDER BY created_at",
      [projectId],
    );
    const names = rows
      .map((r) => r.message.match(/\[check:(\w+)\]/)?.[1])
      .filter((n): n is string => !!n);
    expect(names).toEqual(["first", "second"]);
  });

  it("project settings.checks override the role default", async () => {
    // Role default would PASS via "true"; project override forces FAIL via "false".
    agentConfigs.backend.checks = [
      { name: "role-default", pattern: "src/backend/**/*.ts", command: "true", onFail: "warn" },
    ];
    await getPool().query(
      `UPDATE projects SET settings = $1 WHERE id = $2`,
      [JSON.stringify({
        checks: {
          backend: [{ name: "project-override", pattern: "src/backend/**/*.ts", command: "false", onFail: "alert" }],
        },
      }), projectId],
    );

    await enqueueCheck("src/backend/x.ts");
    await runOneJob();

    const { rows: logs } = await getPool().query(
      "SELECT message FROM agent_logs WHERE project_id = $1",
      [projectId],
    );
    // Override ran, role default did not
    expect(logs.some((r) => r.message.includes("project-override"))).toBe(true);
    expect(logs.some((r) => r.message.includes("role-default"))).toBe(false);

    // alert severity → signal
    const { rows: signals } = await getPool().query(
      "SELECT to_role FROM signals WHERE project_id = $1",
      [projectId],
    );
    expect(signals.length).toBe(1);
    expect(signals[0].to_role).toBe("tech-lead");
  });

  it("handles absolute file paths (strips worktree prefix)", async () => {
    agentConfigs.backend.checks = [
      { name: "abs", pattern: "src/backend/**/*.ts", command: "true", onFail: "warn" },
    ];
    await enqueueCheck(path.join(worktree, "src/backend/x.ts"));
    await runOneJob();

    const { rows } = await getPool().query(
      "SELECT message FROM agent_logs WHERE project_id = $1",
      [projectId],
    );
    expect(rows.some((r) => r.message.includes("[check:abs] PASS"))).toBe(true);
  });
});
