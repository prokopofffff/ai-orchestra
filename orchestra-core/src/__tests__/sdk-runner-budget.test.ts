import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { waitForDatabase, runMigrations, getPool } from "../db";

// Mock the SDK — drive a synthetic message stream including a final
// `error_max_budget_usd` result so the runner exercises the cap branch.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { runAgentSdk } from "../agents/sdk-runner";
import { getSessionController } from "../session-manager";

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
  await pool.query("DELETE FROM tasks WHERE title LIKE 'budget-test%'");
  await pool.query("DELETE FROM projects WHERE slug = 'budget-test'");

  const { rows: pRows } = await pool.query(
    "INSERT INTO projects (name, slug) VALUES ('Budget Test', 'budget-test') RETURNING id",
  );
  projectId = pRows[0].id;
  await pool.query("INSERT INTO conversations (project_id) VALUES ($1)", [projectId]);
  const { rows: tRows } = await pool.query(
    "INSERT INTO tasks (project_id, title) VALUES ($1, 'budget-test-task') RETURNING id",
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

function makeStream(messages: SDKMessage[]): AsyncIterable<SDKMessage> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < messages.length) return { value: messages[i++], done: false };
          return { value: undefined as unknown as SDKMessage, done: true };
        },
      };
    },
  };
}

const budgetExceededResult: SDKMessage = {
  type: "result",
  subtype: "error_max_budget_usd",
  duration_ms: 5000,
  duration_api_ms: 4000,
  is_error: true,
  num_turns: 3,
  stop_reason: null,
  total_cost_usd: 5.5,
  usage: {} as never,
  modelUsage: {
    "claude-sonnet-4-6": {
      inputTokens: 1000, outputTokens: 200,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      webSearchRequests: 0, costUSD: 5.5,
      contextWindow: 0, maxOutputTokens: 0,
    },
  } as never,
  permission_denials: [],
  errors: [],
  uuid: "00000000-0000-0000-0000-000000000000",
  session_id: "fake",
} as unknown as SDKMessage;

const successResult: SDKMessage = {
  ...(budgetExceededResult as object),
  subtype: "success",
  is_error: false,
  result: "ok",
  total_cost_usd: 0.42,
  modelUsage: {
    "claude-sonnet-4-6": {
      inputTokens: 800, outputTokens: 100,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      webSearchRequests: 0, costUSD: 0.42,
      contextWindow: 0, maxOutputTokens: 0,
    },
  } as never,
} as unknown as SDKMessage;

describe("sdk-runner — per-run budget cap", () => {
  it("passes maxBudgetUsd from limits and records it in the run start log", async () => {
    vi.mocked(query).mockReturnValue(makeStream([successResult]) as never);

    await runAgentSdk({
      projectId, taskId, sessionId, role: "backend",
      model: "sonnet", worktree: "/tmp/wt",
      fullPrompt: "do thing", mcpServers: {},
    });

    const callArgs = vi.mocked(query).mock.calls[0][0] as { options: { maxBudgetUsd: number } };
    expect(callArgs.options.maxBudgetUsd).toBe(2); // backend default
  });

  it("uses per-role override from project settings", async () => {
    vi.mocked(query).mockReturnValue(makeStream([successResult]) as never);

    await runAgentSdk({
      projectId, taskId, sessionId, role: "tech-lead",
      model: "opus", worktree: "/tmp/wt",
      fullPrompt: "plan", mcpServers: {},
      settings: { limits: { perRunBudgetUsd: { "tech-lead": 12 } } },
    });

    const callArgs = vi.mocked(query).mock.calls.at(-1)?.[0] as { options: { maxBudgetUsd: number } };
    expect(callArgs.options.maxBudgetUsd).toBe(12);
  });

  it("on error_max_budget_usd: returns capExceeded and writes an escalate signal", async () => {
    vi.mocked(query).mockReturnValue(makeStream([budgetExceededResult]) as never);

    const outcome = await runAgentSdk({
      projectId, taskId, sessionId, role: "backend",
      model: "sonnet", worktree: "/tmp/wt",
      fullPrompt: "loop", mcpServers: {},
    });

    expect(outcome.capExceeded?.kind).toBe("budget");
    expect(outcome.capExceeded?.detail).toMatch(/per-run budget/);

    const { rows: signals } = await getPool().query(
      `SELECT action, payload FROM signals WHERE project_id = $1`,
      [projectId],
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].action).toBe("escalate");
    expect(signals[0].payload).toMatchObject({ event: "budget_cap", role: "backend" });

    const { rows: costs } = await getPool().query(
      `SELECT result_subtype, cost_usd::float8 AS cost FROM usage_costs WHERE project_id = $1`,
      [projectId],
    );
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ result_subtype: "error_max_budget_usd", cost: 5.5 });
  });

  it("registers an AbortController under the session id and clears it on completion", async () => {
    let observed: AbortController | undefined;
    vi.mocked(query).mockImplementation(() => {
      observed = getSessionController(sessionId);
      return makeStream([successResult]) as never;
    });

    await runAgentSdk({
      projectId, taskId, sessionId, role: "backend",
      model: "sonnet", worktree: "/tmp/wt",
      fullPrompt: "x", mcpServers: {},
    });

    expect(observed).toBeInstanceOf(AbortController);
    expect(getSessionController(sessionId)).toBeUndefined();
  });
});
