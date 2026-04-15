/**
 * Thin wrapper over graphile-worker that preserves the API surface our
 * callers already use: `enqueue`, `registerCron`, `registerHandler`,
 * `registerBucket`, `startScheduler`, `stopScheduler`, `runOneJob`.
 *
 * We keep one piece of domain logic that graphile-worker doesn't ship —
 * token-bucket rate limiting — implemented via graphile-worker's
 * `flags` + `forbiddenFlagsFn`: jobs tagged with `bucket:<key>` are gated
 * by a poll of `rate_buckets`. Handlers atomically decrement on run.
 */

import { z } from "zod";
import {
  run,
  runOnce,
  parseCrontab,
  quickAddJob,
  type Runner,
  type TaskList,
  type JobHelpers,
  type ParsedCronItem,
} from "graphile-worker";
import { getPool } from "./db";
import { withContext, log } from "./obs";

// ─── Public types ───

export type Handler<T = unknown> = (
  payload: T,
  ctx: HandlerCtx,
) => Promise<void>;

export type HandlerCtx = {
  job: { id: string; attempts: number; maxAttempts: number };
  log: (msg: string) => void;
  /** Back-compat no-op — graphile-worker handles heartbeating internally. */
  extendLease: (ms?: number) => Promise<void>;
};

export type EnqueueOptions = {
  kind: string;
  payload?: unknown;
  runAt?: Date;
  bucketKey?: string;
  maxAttempts?: number;
  priority?: number;
};

export type CronOptions = {
  key: string;
  kind: string;
  cron?: string;           // cron expression
  intervalSeconds?: number;
  payload?: unknown;
  bucketKey?: string;
};

export type BucketSpec = {
  key: string;
  capacity: number;
  refillPerSecond: number;
};

// ─── Handler registry ───

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- handler generics erase at storage time
type Registered = { schema: z.ZodType; fn: Handler<any> };
const registry = new Map<string, Registered>();
const cronsPending: CronOptions[] = [];

export function registerHandler<T>(
  kind: string,
  schema: z.ZodType<T>,
  fn: Handler<T>,
): void {
  if (registry.has(kind)) throw new Error(`Handler already registered: ${kind}`);
  registry.set(kind, { schema, fn });
}

export function listHandlerKinds(): string[] {
  return [...registry.keys()];
}

// ─── Enqueue & cron ───

export async function enqueue(opts: EnqueueOptions): Promise<string> {
  const spec = {
    runAt: opts.runAt,
    priority: opts.priority,
    maxAttempts: opts.maxAttempts ?? 5,
    flags: opts.bucketKey ? [`bucket:${opts.bucketKey}`] : undefined,
  };
  const job = await quickAddJob(
    { pgPool: getPool() },
    opts.kind,
    opts.payload ?? {},
    spec,
  );
  return String(job.id);
}

/**
 * Register (or update) a recurring job. Must be called before startScheduler();
 * cron items are baked into the runner at start.
 */
export async function registerCron(opts: CronOptions): Promise<void> {
  if (!opts.cron && !opts.intervalSeconds) {
    throw new Error("registerCron requires cron or intervalSeconds");
  }
  const existing = cronsPending.find((c) => c.key === opts.key);
  if (existing) Object.assign(existing, opts);
  else cronsPending.push(opts);
}

// ─── Buckets ───
//
// We kept our `rate_buckets` table from the old scheduler (migration 008).
// Enqueue tags jobs; forbiddenFlagsFn polls refill math and blocks exhausted
// buckets until tokens return.

export async function registerBucket(spec: BucketSpec): Promise<void> {
  await getPool().query(
    `INSERT INTO rate_buckets (key, tokens, capacity, refill_rate, updated_at)
     VALUES ($1, $2, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET capacity = EXCLUDED.capacity, refill_rate = EXCLUDED.refill_rate`,
    [spec.key, spec.capacity, spec.refillPerSecond],
  );
}

/**
 * Return the list of bucket-flags whose buckets have <1 effective token
 * (considering refill since updated_at). graphile-worker will skip any job
 * bearing any of these flags on this poll cycle.
 */
async function forbiddenBucketFlags(): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT key FROM rate_buckets
     WHERE LEAST(capacity, tokens + refill_rate * EXTRACT(EPOCH FROM (now() - updated_at))) < 1`,
  );
  return rows.map((r) => `bucket:${r.key as string}`);
}

/**
 * Try to atomically spend 1 token from a bucket. Returns true on success.
 * Called by the handler wrapper before running the real task.
 */
async function spendBucketToken(key: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE rate_buckets
     SET tokens = LEAST(capacity, tokens + refill_rate * EXTRACT(EPOCH FROM (now() - updated_at))) - 1,
         updated_at = now()
     WHERE key = $1
       AND LEAST(capacity, tokens + refill_rate * EXTRACT(EPOCH FROM (now() - updated_at))) >= 1`,
    [key],
  );
  return (rowCount ?? 0) > 0;
}

// ─── Runtime ───

let runner: Runner | null = null;

export type WorkerConfig = {
  concurrency?: number;
  /** Poll interval in ms (default 2000). */
  pollInterval?: number;
};

export async function startScheduler(cfg: WorkerConfig = {}): Promise<void> {
  if (runner) return;

  const taskList = buildTaskList();
  const parsedCronItems = buildCronItems();

  runner = await run({
    pgPool: getPool(),
    taskList,
    parsedCronItems,
    concurrency: cfg.concurrency ?? 4,
    pollInterval: cfg.pollInterval ?? 2000,
    forbiddenFlags: forbiddenBucketFlags,
  });

  log.info({
    handlers: taskList ? Object.keys(taskList).length : 0,
    crons: parsedCronItems.length,
    concurrency: cfg.concurrency ?? 4,
  }, "scheduler started");
}

export async function stopScheduler(): Promise<void> {
  if (!runner) return;
  await runner.stop();
  runner = null;
}

// ─── Task-list adapter ───

function buildTaskList(): TaskList {
  const list: TaskList = {};
  for (const [kind, reg] of registry.entries()) {
    list[kind] = wrapTask(kind, reg);
  }
  return list;
}

function wrapTask(kind: string, reg: Registered) {
  return async (payload: unknown, helpers: JobHelpers): Promise<void> => {
    return withContext(
      { jobId: String(helpers.job.id), jobKind: kind, attempt: helpers.job.attempts },
      async () => {
        // graphile-worker stores flags as { [flag]: true }.
        const bucketFlag = helpers.job.flags
          ? Object.keys(helpers.job.flags).find((f) => f.startsWith("bucket:"))
          : undefined;
        if (bucketFlag) {
          const bucketKey = bucketFlag.slice("bucket:".length);
          const ok = await spendBucketToken(bucketKey);
          if (!ok) {
            throw new BucketEmpty(`bucket ${bucketKey} empty at run time`);
          }
        }

        const parsed = reg.schema.safeParse(payload);
        if (!parsed.success) {
          throw new Error(`invalid payload for ${kind}: ${parsed.error.message}`);
        }

        const ctx: HandlerCtx = {
          job: {
            id: String(helpers.job.id),
            attempts: helpers.job.attempts,
            maxAttempts: helpers.job.max_attempts,
          },
          log: (msg) => log.info(msg),
          extendLease: async () => { /* graphile-worker handles heartbeat */ },
        };

        await reg.fn(parsed.data, ctx);
      },
    );
  };
}

class BucketEmpty extends Error {
  constructor(msg: string) { super(msg); this.name = "BucketEmpty"; }
}

// ─── Cron adapter ───

function buildCronItems(): ParsedCronItem[] {
  if (cronsPending.length === 0) return [];
  const lines = cronsPending.map((c) => {
    const pattern = c.cron ?? everyIntervalToCron(c.intervalSeconds!);
    const payloadJson = JSON.stringify(c.payload ?? {});
    const flags = c.bucketKey ? ` flags="bucket:${c.bucketKey}"` : "";
    return `${pattern} ${c.kind} ?id=${c.key}&fill=0m${flags} ${payloadJson}`;
  });
  return parseCrontab(lines.join("\n"));
}

/**
 * Approximate "every N seconds" in cron. graphile-worker crontab uses standard
 * cron (minute resolution), so we round up to minutes. For sub-minute work,
 * register crons externally or use enqueue+self-reschedule.
 */
function everyIntervalToCron(seconds: number): string {
  if (seconds < 60) return "* * * * *"; // every minute (floor)
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes === 1) return "* * * * *";
  return `*/${minutes} * * * *`;
}

// ─── Test helper ───

/**
 * Run all currently-due jobs to completion in-process. Wraps graphile-worker's
 * `runOnce`. Returns when the queue is empty (or all remaining are future/blocked).
 */
export async function runOneJob(): Promise<void> {
  await runOnce({
    pgPool: getPool(),
    taskList: buildTaskList(),
    concurrency: 1,
    forbiddenFlags: forbiddenBucketFlags,
  });
}
