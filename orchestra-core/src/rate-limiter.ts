import { getPool } from "./db.js";
import { type Config, type AgentRole } from "./config.js";
import { spawnAgent } from "./agent-spawner.js";

// ─── Priority per role ───

const rolePriority: Record<AgentRole, number> = {
  "tech-lead": 100,
  designer: 50,
  frontend: 40,
  backend: 40,
  qa: 30,
  devops: 20,
};

// ─── State ───

let rateLimited = false;
let rateLimitResetTime: Date | null = null;
let resetTimeoutId: ReturnType<typeof setTimeout> | null = null;
let processing = false;

// ─── Enqueue ───

export interface EnqueueParams {
  projectId: string;
  taskId: string;
  role: AgentRole;
  config: Config;
  resumeSessionId?: string;
  retryCount?: number;
}

export async function enqueue(params: EnqueueParams): Promise<string> {
  const pool = getPool();
  const priority = rolePriority[params.role] ?? 40;

  const { rows } = await pool.query(
    `INSERT INTO task_queue (project_id, task_id, role, priority, retry_count)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [params.projectId, params.taskId, params.role, priority, params.retryCount ?? 0],
  );

  // Trigger processing (async, don't await)
  processQueue(params.config).catch(console.error);

  return rows[0].id;
}

// ─── Process Queue ───

export async function processQueue(config: Config): Promise<void> {
  if (processing || rateLimited) return;
  processing = true;

  try {
    const pool = getPool();

    // Get next queued item by priority (highest first)
    const { rows } = await pool.query(
      `SELECT * FROM task_queue
       WHERE status = 'queued'
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`,
    );

    if (!rows.length) {
      processing = false;
      return;
    }

    const item = rows[0];

    // Mark as running
    await pool.query(
      "UPDATE task_queue SET status = 'running', started_at = now() WHERE id = $1",
      [item.id],
    );

    try {
      await spawnAgent({
        projectId: item.project_id,
        taskId: item.task_id,
        role: item.role as AgentRole,
        config,
        resumeSessionId: undefined, // TODO: pass from enqueue params
      });

      // Mark as completed
      await pool.query(
        "UPDATE task_queue SET status = 'completed', finished_at = now() WHERE id = $1",
        [item.id],
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Check for rate limit
      if (isRateLimitError(errorMsg)) {
        handleRateLimit(errorMsg, config);
        // Return item to queue
        await pool.query(
          "UPDATE task_queue SET status = 'queued' WHERE id = $1",
          [item.id],
        );
      } else {
        // Mark as failed
        await pool.query(
          "UPDATE task_queue SET status = 'failed', finished_at = now() WHERE id = $1",
          [item.id],
        );
        console.error(`Queue item ${item.id} failed:`, errorMsg);
      }
    }
  } finally {
    processing = false;
  }

  // Continue processing if more items
  const pool = getPool();
  const { rows: remaining } = await pool.query(
    "SELECT COUNT(*) as count FROM task_queue WHERE status = 'queued'",
  );
  if (Number(remaining[0].count) > 0 && !rateLimited) {
    processQueue(config).catch(console.error);
  }
}

// ─── Rate Limit Detection ───

function isRateLimitError(message: string): boolean {
  const patterns = [
    "rate limit",
    "rate_limit",
    "too many requests",
    "429",
    "exceeded your",
    "try again",
  ];
  const lower = message.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

function handleRateLimit(errorMsg: string, config: Config): void {
  rateLimited = true;

  // Try to parse reset time from error message
  const resetMatch = errorMsg.match(/(\d+)\s*(seconds?|minutes?|hours?)/i);
  let delayMs = 5 * 60_000; // default 5 minutes

  if (resetMatch) {
    const value = Number(resetMatch[1]);
    const unit = resetMatch[2].toLowerCase();
    if (unit.startsWith("second")) delayMs = value * 1000;
    else if (unit.startsWith("minute")) delayMs = value * 60_000;
    else if (unit.startsWith("hour")) delayMs = value * 3600_000;
  }

  rateLimitResetTime = new Date(Date.now() + delayMs);
  console.log(`Rate limited. Queue paused until ${rateLimitResetTime.toISOString()}`);

  // Schedule resume
  if (resetTimeoutId) clearTimeout(resetTimeoutId);
  resetTimeoutId = setTimeout(() => {
    rateLimited = false;
    rateLimitResetTime = null;
    console.log("Rate limit reset. Resuming queue.");
    processQueue(config).catch(console.error);
  }, delayMs);
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
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int as count FROM task_queue GROUP BY status`,
  );

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.status as string] = row.count as number;
  }

  return {
    rateLimited,
    rateLimitResetTime: rateLimitResetTime?.toISOString() ?? null,
    queued: counts.queued ?? 0,
    running: counts.running ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
  };
}

// ─── Reconciliation (on startup) ───

export async function reconcileQueue(): Promise<void> {
  const pool = getPool();
  // Any items stuck in 'running' state after restart → back to queued
  const { rowCount } = await pool.query(
    "UPDATE task_queue SET status = 'queued' WHERE status = 'running'",
  );
  if (rowCount && rowCount > 0) {
    console.log(`Reconciled ${rowCount} stuck queue items back to queued`);
  }
}
