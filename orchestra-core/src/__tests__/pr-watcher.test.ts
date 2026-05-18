import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db";
import { runOneJob, enqueue, registerBucket } from "../scheduler";
import "../pr-watcher"; // side-effect: registers the handlers

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

const PR_DISCOVER_KIND = "pr-watcher:discover";
const PR_CHECK_ONE_KIND = "pr-watcher:check-one";

let projectId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM graphile_worker._private_jobs").catch(() => {});
  await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM projects WHERE slug = 'pr-test'");
  // 0-token bucket: enqueue tags check-one with bucket:github:rest, the
  // forbiddenFlags check then keeps those jobs queued so we can assert their
  // shape. Without this, runOneJob() would drain them before the test SELECTs.
  await pool.query("DELETE FROM rate_buckets WHERE key = 'github:rest'");
  await registerBucket({ key: "github:rest", capacity: 0, refillPerSecond: 0 });

  // Per-project provider token — providerFor no longer falls back to
  // env.GITHUB_TOKEN. Individual tests blank this when they want to
  // exercise the "no token / skipped" path.
  const { rows } = await pool.query(
    `INSERT INTO projects (name, slug, repo_url, settings)
     VALUES ('PR Test', 'pr-test', 'https://github.com/test/pr',
             '{"provider":{"token":"fake-token"}}'::jsonb)
     RETURNING id`,
  );
  projectId = rows[0].id;
});

afterEach(() => {
  delete process.env.GITHUB_TOKEN;
});

afterAll(async () => {
  await getPool().end();
});

async function makeTask(opts: { prUrl?: string | null; state?: string; title?: string }): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO tasks (project_id, title, pr_url, state)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [projectId, opts.title ?? "T", opts.prUrl ?? null, opts.state ?? "pr_created"],
  );
  return rows[0].id;
}

async function runDiscovery(): Promise<void> {
  await enqueue({ kind: PR_DISCOVER_KIND, payload: {} });
  await runOneJob();
}

async function pendingCheckJobs(): Promise<Array<{ taskId: string }>> {
  const { rows } = await getPool().query(
    `SELECT j.payload->>'taskId' AS "taskId"
     FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     WHERE t.identifier = $1`,
    [PR_CHECK_ONE_KIND],
  );
  return rows;
}

describe("pr-watcher — discover handler", () => {
  it("is a no-op when the project has no provider token configured", async () => {
    // Drop the per-project token; providerFor will throw and the discover
    // handler should skip the task instead of queueing a check that would
    // 401.
    await getPool().query(
      "UPDATE projects SET settings = '{}'::jsonb WHERE id = $1",
      [projectId],
    );
    await makeTask({ prUrl: "https://github.com/o/r/pull/1", state: "pr_created" });
    await runDiscovery();
    expect(await pendingCheckJobs()).toHaveLength(0);
  });

  it("enqueues a check-one job per task with a PR", async () => {
    process.env.GITHUB_TOKEN = "fake-token";
    const t1 = await makeTask({ prUrl: "https://github.com/o/r/pull/1", state: "pr_created", title: "one" });
    const t2 = await makeTask({ prUrl: "https://github.com/o/r/pull/2", state: "approved",   title: "two" });
    await runDiscovery();

    const queued = await pendingCheckJobs();
    expect(queued.map((j) => j.taskId).sort()).toEqual([t1, t2].sort());
  });

  it("skips tasks without a PR URL", async () => {
    process.env.GITHUB_TOKEN = "fake-token";
    await makeTask({ prUrl: null, state: "pr_created" });
    await runDiscovery();
    expect(await pendingCheckJobs()).toHaveLength(0);
  });

  it("skips tasks in terminal states (merged, closed)", async () => {
    process.env.GITHUB_TOKEN = "fake-token";
    await makeTask({ prUrl: "https://github.com/o/r/pull/1", state: "merged" });
    await makeTask({ prUrl: "https://github.com/o/r/pull/2", state: "closed" });
    await runDiscovery();
    expect(await pendingCheckJobs()).toHaveLength(0);
  });

  it("deduplicates: doesn't re-enqueue if a check job already exists for the task", async () => {
    process.env.GITHUB_TOKEN = "fake-token";
    const taskId = await makeTask({ prUrl: "https://github.com/o/r/pull/1", state: "pr_created" });

    // First discovery run — enqueues one check job.
    await runDiscovery();
    expect(await pendingCheckJobs()).toHaveLength(1);

    // Second discovery run — should see the existing job and skip.
    // Drain the discover job the second enqueue creates before asserting.
    await runDiscovery();
    const second = await pendingCheckJobs();
    expect(second.filter((j) => j.taskId === taskId)).toHaveLength(1);
  });

  it("tags enqueued check-one jobs with the github:rest bucket flag", async () => {
    process.env.GITHUB_TOKEN = "fake-token";
    await makeTask({ prUrl: "https://github.com/o/r/pull/1", state: "pr_created" });
    await runDiscovery();

    const { rows } = await getPool().query(
      `SELECT j.flags
       FROM graphile_worker._private_jobs j
       JOIN graphile_worker._private_tasks t ON t.id = j.task_id
       WHERE t.identifier = $1`,
      [PR_CHECK_ONE_KIND],
    );
    expect(rows[0].flags).toHaveProperty("bucket:github:rest", true);
  });
});
