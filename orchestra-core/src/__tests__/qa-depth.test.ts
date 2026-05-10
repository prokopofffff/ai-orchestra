import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import Fastify from "fastify";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { signalPlugin } from "../signal-api";
import { setupTestUser, getOrCreateTestUser } from "./helpers/test-auth";

vi.mock("../dispatcher", () => ({
  dispatchSignal: vi.fn().mockResolvedValue({ dispatched: false }),
}));

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let projectId: string;
let taskId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM signals");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM conversations");
  await pool.query("DELETE FROM flow_audit");
  await pool.query("DELETE FROM tasks WHERE title LIKE 'qa-depth%'");
  await pool.query("DELETE FROM projects WHERE slug = 'qa-depth'");

  const userId = await getOrCreateTestUser("qa-depth@orchestra.local");
  // Tight cap = 2 to avoid sending dozens of test signals.
  const settings = JSON.stringify({ limits: { maxQaDepth: 2 } });
  const { rows: pRows } = await pool.query(
    "INSERT INTO projects (name, slug, settings, owner_id) VALUES ('QA Depth', 'qa-depth', $1::jsonb, $2) RETURNING id",
    [settings, userId],
  );
  projectId = pRows[0].id;
  await pool.query("INSERT INTO conversations (project_id) VALUES ($1)", [projectId]);
  const { rows: tRows } = await pool.query(
    `INSERT INTO tasks (project_id, title, state, assignee_role)
     VALUES ($1, 'qa-depth-task', 'in_development', 'backend') RETURNING id`,
    [projectId],
  );
  taskId = tRows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

async function buildApp() {
  const app = Fastify();
  await setupTestUser(app, "qa-depth@orchestra.local");
  await app.register(signalPlugin, { prefix: "/api" });
  await app.ready();
  return app;
}

async function ask(app: ReturnType<typeof Fastify>) {
  return app.inject({
    method: "POST", url: "/api/signal",
    payload: {
      from: "backend", to: "tech-lead", action: "question",
      projectId, taskId, payload: { message: "?" },
    },
  });
}

describe("signal-api — Q&A depth cap", () => {
  it("accepts up to maxQaDepth questions then rejects with one escalate", async () => {
    const app = await buildApp();

    expect((await ask(app)).statusCode).toBe(201);
    expect((await ask(app)).statusCode).toBe(201);
    // 3rd question — at boundary, rejected with escalate
    const third = await ask(app);
    expect(third.statusCode).toBe(429);
    // 4th — silent reject, no further escalate
    const fourth = await ask(app);
    expect(fourth.statusCode).toBe(429);

    await app.close();

    const { rows: escalates } = await getPool().query(
      "SELECT payload FROM signals WHERE project_id = $1 AND action = 'escalate'", [projectId],
    );
    expect(escalates).toHaveLength(1);
    expect(escalates[0].payload).toMatchObject({ event: "qa_depth_cap", count: 2, cap: 2 });

    const { rows: audits } = await getPool().query(
      "SELECT reason FROM flow_audit WHERE project_id = $1 AND status = 'rejected'", [projectId],
    );
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits.every((a) => a.reason === "qa_depth_exceeded")).toBe(true);
  });

  it("answers don't count toward the cap", async () => {
    // Pre-seed maxQaDepth-1 questions then alternate answer/question — should accept.
    await getPool().query(
      `INSERT INTO signals (project_id, task_id, from_role, to_role, action) VALUES
        ($1, $2, 'backend', 'tech-lead', 'question'),
        ($1, $2, 'tech-lead', 'backend', 'answer')`,
      [projectId, taskId],
    );

    const app = await buildApp();
    // 2nd question — should be accepted (cap is 2, prior count = 1)
    const res = await ask(app);
    await app.close();
    expect(res.statusCode).toBe(201);
  });
});
