import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { waitForDatabase, runMigrations, getPool } from "../db";
import {
  enqueue,
  registerHandler,
  registerBucket,
  runOneJob,
  type Handler,
} from "../scheduler";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

const payloadSchema = z.object({}).passthrough();

function makeHandler(fn: Handler<unknown>): string {
  const kind = `test:${randomUUID()}`;
  registerHandler(kind, payloadSchema, fn);
  return kind;
}

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  // graphile-worker owns graphile_worker.jobs; clean between tests
  await getPool().query("DELETE FROM graphile_worker._private_jobs").catch(() => {});
  await getPool().query("DELETE FROM rate_buckets WHERE key LIKE 'test:%'");
});

afterAll(async () => {
  await getPool().end();
});

describe("scheduler (graphile-worker)", () => {
  it("runOneJob executes an enqueued handler with parsed payload", async () => {
    let captured: unknown = null;
    const kind = makeHandler(async (p) => { captured = p; });

    await enqueue({ kind, payload: { hello: "world" } });
    await runOneJob();

    expect(captured).toEqual({ hello: "world" });
  });

  it("rejects payloads that fail the schema", async () => {
    const strict = z.object({ n: z.number() });
    const kind = `test:${randomUUID()}`;
    registerHandler(kind, strict, async () => {});

    await enqueue({ kind, payload: { n: "not-a-number" } });
    await runOneJob();

    // Job should now be failed/retrying in graphile-worker's table
    const { rows } = await getPool().query(
      `SELECT attempts, last_error FROM graphile_worker.jobs WHERE task_identifier = $1`,
      [kind],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].attempts).toBeGreaterThanOrEqual(1);
    expect(String(rows[0].last_error)).toContain("invalid payload");
  });

  it("respects runAt — future jobs aren't run by runOneJob now", async () => {
    const ran: string[] = [];
    const kind = makeHandler(async (p) => { ran.push((p as { tag: string }).tag); });

    await enqueue({ kind, payload: { tag: "now" } });
    await enqueue({ kind, payload: { tag: "future" }, runAt: new Date(Date.now() + 60_000) });
    await runOneJob();

    expect(ran).toEqual(["now"]);
  });

  it("bucket gating: jobs on an empty bucket are skipped (flag-blocked)", async () => {
    const kind = makeHandler(async () => {});
    await registerBucket({ key: "test:empty", capacity: 1, refillPerSecond: 0 });
    await getPool().query(`UPDATE rate_buckets SET tokens = 0, updated_at = now() WHERE key = 'test:empty'`);

    await enqueue({ kind, bucketKey: "test:empty" });
    await runOneJob();

    // The bucket flag is forbidden → worker skipped the job entirely.
    const { rows } = await getPool().query(
      `SELECT attempts FROM graphile_worker.jobs WHERE task_identifier = $1`,
      [kind],
    );
    expect(rows[0]?.attempts ?? 0).toBe(0);
  });

  it("bucket gating: jobs on a full bucket run and the token is spent", async () => {
    const kind = makeHandler(async () => {});
    await registerBucket({ key: "test:full", capacity: 5, refillPerSecond: 0 });

    await enqueue({ kind, bucketKey: "test:full" });
    await runOneJob();

    const { rows: buckets } = await getPool().query(
      `SELECT tokens FROM rate_buckets WHERE key = 'test:full'`,
    );
    expect(Number(buckets[0].tokens)).toBeCloseTo(4, 1);

    const { rows: jobs } = await getPool().query(
      `SELECT COUNT(*)::int as n FROM graphile_worker.jobs WHERE task_identifier = $1`,
      [kind],
    );
    expect(jobs[0].n).toBe(0); // completed → removed from the jobs table
  });

  it("registerBucket upserts capacity + refill_rate", async () => {
    await registerBucket({ key: "test:upsert", capacity: 3, refillPerSecond: 0.1 });
    await registerBucket({ key: "test:upsert", capacity: 7, refillPerSecond: 0.5 });

    const { rows } = await getPool().query(
      `SELECT capacity, refill_rate FROM rate_buckets WHERE key = 'test:upsert'`,
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0].capacity)).toBe(7);
    expect(Number(rows[0].refill_rate)).toBe(0.5);
  });
});
