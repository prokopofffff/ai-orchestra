import { z } from "zod";
import { sql } from "drizzle-orm";
import { getPool, getDb } from "./db";
import { type Config, type AgentRole } from "./config";
import { spawnAgent } from "./agent-spawner";
import { logBackgroundError } from "./error-handler";
import { registerHandler, enqueue as scheduleJob } from "./scheduler";
import { log } from "./obs";

// ─── Priority per role ───

const rolePriority: Record<AgentRole, number> = {
  "tech-lead": 100,
  designer: 50,
  frontend: 40,
  backend: 40,
  qa: 30,
  devops: 20,
};

// ─── Bucket ───

export const CLAUDE_BUCKET = "claude:api";

// On a 429, we drain the bucket so subsequent claims defer.
// Refill rate stays constant — tokens come back over the cooldown window.
// (Worker also treats jobs as retryable, so they re-claim once tokens return.)

// ─── Enqueue ───

export interface EnqueueParams {
  projectId: string;
  taskId: string;
  role: AgentRole;
  config: Config;
  resumeSessionId?: string;
  retryCount?: number;
}

const AGENT_RUN_KIND = "agent-run";

const AgentRunPayload = z.object({
  projectId: z.string(),
  taskId: z.string(),
  role: z.enum(["tech-lead", "designer", "frontend", "backend", "qa", "devops"]),
  resumeSessionId: z.string().optional(),
});

export async function enqueue(params: EnqueueParams): Promise<string> {
  const priority = rolePriority[params.role] ?? 40;

  // graphile-worker owns the queue; no separate ledger row. `attempts` on the
  // job itself is the source of truth for retry counts (see getRetryCount).
  const id = await scheduleJob({
    kind: AGENT_RUN_KIND,
    bucketKey: CLAUDE_BUCKET,
    priority,
    // High cap: rate-limit retries deliberately re-enter the queue; genuine
    // errors are non-throwing and won't consume attempts.
    maxAttempts: 50,
    payload: {
      projectId: params.projectId,
      taskId: params.taskId,
      role: params.role,
      resumeSessionId: params.resumeSessionId,
    },
  });

  return id;
}

/**
 * Retry count for (taskId, role) — replaces the old task_queue.retry_count
 * read. Pulls `attempts` from the most recent matching agent-run row in
 * graphile-worker's private table.
 */
export async function getRetryCount(taskId: string, role: AgentRole): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT j.attempts
     FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     WHERE t.identifier = $1
       AND j.payload->>'taskId' = $2
       AND j.payload->>'role' = $3
     ORDER BY j.created_at DESC
     LIMIT 1`,
    [AGENT_RUN_KIND, taskId, role],
  );
  return (rows[0]?.attempts as number) ?? 0;
}

// ─── Handler ───

class RateLimitError extends Error {
  constructor(message: string, public retryAfterMs: number) {
    super(message);
  }
}

// Config is captured at registration time. Set once during boot.
let runtimeConfig: Config | null = null;

export function bindAgentRunner(config: Config): void {
  runtimeConfig = config;
}

registerHandler(AGENT_RUN_KIND, AgentRunPayload, async (p, ctx) => {
  if (!runtimeConfig) throw new Error("agent-runner not bound — call bindAgentRunner(config) at startup");

  try {
    await ctx.extendLease();
    await spawnAgent({
      projectId: p.projectId,
      taskId: p.taskId,
      role: p.role,
      config: runtimeConfig,
      resumeSessionId: p.resumeSessionId,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (isRateLimitError(errorMsg)) {
      const delayMs = parseRateLimitDelay(errorMsg);
      // Drain bucket so other queued agent-runs defer for the cooldown window.
      await drainBucket(CLAUDE_BUCKET, delayMs);
      ctx.log(`rate limited — bucket drained for ~${Math.round(delayMs / 1000)}s`);
      throw new RateLimitError(errorMsg, delayMs);
    }

    // Non-rate-limit error — terminal. Don't throw (would trigger scheduler retry).
    log.error({ role: p.role, projectId: p.projectId, taskId: p.taskId, err }, "agent-run failed");
    logBackgroundError("agent-run", err, p.projectId);
  }
});

// ─── Rate limit detection ───

function isRateLimitError(message: string): boolean {
  const patterns = ["rate limit", "rate_limit", "too many requests", "429", "exceeded your", "try again"];
  const lower = message.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

function parseRateLimitDelay(errorMsg: string): number {
  const m = errorMsg.match(/(\d+)\s*(seconds?|minutes?|hours?)/i);
  if (!m) return 5 * 60_000;
  const value = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("second")) return value * 1_000;
  if (unit.startsWith("minute")) return value * 60_000;
  return value * 3_600_000;
}

/**
 * Set bucket tokens to 0 so subsequent claims defer until refill restores them.
 * This is a soft pause — claims push run_at forward by the scheduler's backoff
 * window each time they fail to acquire a token.
 */
async function drainBucket(key: string, _delayMs: number): Promise<void> {
  await getDb().execute(sql`
    UPDATE rate_buckets
    SET tokens = 0, updated_at = now()
    WHERE key = ${key}
  `);
}

// ─── Status ───

export interface QueueStatus {
  rateLimited: boolean;
  rateLimitResetTime: string | null;
  queued: number;
  running: number;
  completed: number;
  failed: number;
}

export async function getQueueStatus(): Promise<QueueStatus> {
  const pool = getPool();

  // graphile-worker is the source of truth for queue state.
  // Completed jobs are deleted on success, so `completed` is always 0 from
  // the queue's perspective — agent_logs is the audit channel for history.
  const { rows: jobRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE locked_at IS NULL AND attempts = 0)::int AS queued,
       COUNT(*) FILTER (WHERE locked_at IS NOT NULL)::int AS running,
       COUNT(*) FILTER (WHERE attempts >= max_attempts AND last_error IS NOT NULL)::int AS failed
     FROM graphile_worker.jobs
     WHERE task_identifier = $1`,
    [AGENT_RUN_KIND],
  ).catch(() => ({ rows: [{ queued: 0, running: 0, failed: 0 }] }));

  const { rows: bucketRows } = await pool.query(
    `SELECT
       LEAST(capacity, tokens + refill_rate * EXTRACT(EPOCH FROM (now() - updated_at))) as eff_tokens,
       refill_rate
     FROM rate_buckets WHERE key = $1`,
    [CLAUDE_BUCKET],
  );
  const b = bucketRows[0];
  const rateLimited = b ? Number(b.eff_tokens) < 1 : false;
  const rateLimitResetTime = (b && rateLimited && Number(b.refill_rate) > 0)
    ? new Date(Date.now() + ((1 - Number(b.eff_tokens)) / Number(b.refill_rate)) * 1000).toISOString()
    : null;

  return {
    rateLimited,
    rateLimitResetTime,
    queued: jobRows[0]?.queued ?? 0,
    running: jobRows[0]?.running ?? 0,
    completed: 0, // graphile-worker deletes completed jobs
    failed: jobRows[0]?.failed ?? 0,
  };
}

// ─── Reconciliation (on startup) ───
//
// graphile-worker's lease expiry handles crashed workers natively — a job's
// `locked_at` times out and it's re-claimed. No app-level reconcile needed.
// Kept as a no-op for back-compat with the existing startup sequence.

export async function reconcileQueue(): Promise<void> {
  // Intentionally empty. graphile-worker owns lock lifecycle.
}
