import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { waitForDatabase, runMigrations, getPool } from "../db";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { runAgentSdk } from "../agents/sdk-runner";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let projectId: string;
let sessionId: string;
let taskId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM usage_costs");
  await pool.query("DELETE FROM signals");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM conversations");
  await pool.query("DELETE FROM agent_logs");
  await pool.query("DELETE FROM sessions");
  await pool.query("DELETE FROM tasks WHERE title LIKE 'timeout-test%'");
  await pool.query("DELETE FROM projects WHERE slug = 'timeout-test'");

  const { rows: pRows } = await pool.query(
    "INSERT INTO projects (name, slug) VALUES ('Timeout Test', 'timeout-test') RETURNING id",
  );
  projectId = pRows[0].id;
  await pool.query("INSERT INTO conversations (project_id) VALUES ($1)", [projectId]);
  const { rows: tRows } = await pool.query(
    "INSERT INTO tasks (project_id, title) VALUES ($1, 'timeout-test-task') RETURNING id",
    [projectId],
  );
  taskId = tRows[0].id;
  const { rows: sRows } = await pool.query(
    `INSERT INTO sessions (project_id, role, task_id, model, status)
     VALUES ($1, 'backend', $2, 'sonnet', 'running') RETURNING id`,
    [projectId, taskId],
  );
  sessionId = sRows[0].id;
});

afterAll(async () => {
  await getPool().end();
});

/**
 * Stream that never produces a message until its AbortSignal fires, at which
 * point it throws — mirroring how the real SDK behaves under abort.
 */
function makeAbortableStream(signal: AbortSignal): AsyncIterable<SDKMessage> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return new Promise((_, reject) => {
            const onAbort = () => reject(new Error(String(signal.reason ?? "aborted")));
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
        },
      };
    },
  };
}

describe("sdk-runner — run timeout watchdog", () => {
  it("aborts the run when runTimeoutMs elapses and reports outcome.capExceeded.kind='timeout'", async () => {
    vi.mocked(query).mockImplementation(((args: { options: { abortController: AbortController } }) => {
      return makeAbortableStream(args.options.abortController.signal) as never;
    }) as never);

    const outcome = await runAgentSdk({
      projectId, taskId, sessionId, role: "backend",
      model: "sonnet", worktree: "/tmp/wt",
      bootstrap: "loop", mcpServers: {},
      settings: { limits: { runTimeoutMs: { backend: 50 } } },
    });

    expect(outcome.capExceeded?.kind).toBe("timeout");
    expect(outcome.capExceeded?.detail).toMatch(/50ms/);

    const { rows: signals } = await getPool().query(
      "SELECT action, payload FROM signals WHERE project_id = $1 AND action = 'escalate'",
      [projectId],
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].payload).toMatchObject({ event: "run_timeout", timeoutMs: 50 });

    const { rows: ses } = await getPool().query(
      "SELECT status FROM sessions WHERE id = $1", [sessionId],
    );
    expect(ses[0].status).toBe("crashed");
  });

  it("rethrows non-abort errors instead of swallowing them", async () => {
    vi.mocked(query).mockImplementation((() => {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw new Error("upstream exploded");
            },
          };
        },
      } as never;
    }) as never);

    await expect(
      runAgentSdk({
        projectId, taskId, sessionId, role: "backend",
        model: "sonnet", worktree: "/tmp/wt",
        bootstrap: "x", mcpServers: {},
      }),
    ).rejects.toThrow(/upstream exploded/);
  });
});
