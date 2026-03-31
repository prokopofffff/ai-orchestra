import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { AgentRoleSchema, type AgentRole } from "./session-manager.js";
import type { AgentSpawner, SpawnAgentInput } from "./agent-spawner.js";
import { parseRow, parseRows } from "./db-utils.js";

export const QueuedTaskSchema = z.object({
  id: z.string().uuid(),
  role: AgentRoleSchema,
  projectId: z.string(),
  taskId: z.string().nullable(),
  prompt: z.string(),
  repoUrl: z.string().nullable(),
  workingDir: z.string().nullable(),
  priority: z.number().int(),
  createdAt: z.coerce.date(),
});
export type QueuedTask = z.infer<typeof QueuedTaskSchema>;

// Higher number = higher priority
const ROLE_PRIORITY: Record<AgentRole, number> = {
  "tech-lead": 100,
  designer: 50,
  frontend: 40,
  backend: 40,
  qa: 30,
  devops: 20,
};

const MAX_CONCURRENT_AGENTS = parseInt(
  process.env.MAX_CONCURRENT_AGENTS || "5",
  10
);

export class RateLimiter {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS task_queue (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        project_id TEXT NOT NULL,
        task_id TEXT,
        prompt TEXT NOT NULL,
        repo_url TEXT,
        working_dir TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS rate_limit_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Reconcile: sync active count with actual running sessions
    await this.reconcile();
  }

  /**
   * Reconcile in-DB state with reality after a restart.
   * Counts actually running sessions from agent_sessions table.
   */
  async reconcile(): Promise<void> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM agent_sessions WHERE status = 'running'`
    );
    const actualRunning = parseInt(result.rows[0].count, 10);

    await this.pool.query(
      `INSERT INTO rate_limit_state (key, value, updated_at)
       VALUES ('active_count', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [String(actualRunning)]
    );

    console.log(`Rate limiter reconciled: ${actualRunning} active sessions`);
  }

  async canSpawn(): Promise<boolean> {
    const activeCount = await this.getActiveCount();
    if (activeCount >= MAX_CONCURRENT_AGENTS) {
      return false;
    }

    const rateLimitedUntil = await this.getRateLimitedUntil();
    if (rateLimitedUntil && new Date() < rateLimitedUntil) {
      return false;
    }

    // Clear expired rate limit
    if (rateLimitedUntil && new Date() >= rateLimitedUntil) {
      await this.clearRateLimit();
    }

    return true;
  }

  async markRateLimited(retryAfterMs: number = 5 * 60 * 1000): Promise<void> {
    const until = new Date(Date.now() + retryAfterMs);

    await this.pool.query(
      `INSERT INTO rate_limit_state (key, value, updated_at)
       VALUES ('rate_limited_until', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [until.toISOString()]
    );

    console.log(`Rate limited until ${until.toISOString()}`);
  }

  async incrementActive(): Promise<void> {
    await this.pool.query(
      `INSERT INTO rate_limit_state (key, value, updated_at)
       VALUES ('active_count', '1', NOW())
       ON CONFLICT (key) DO UPDATE
       SET value = (COALESCE(rate_limit_state.value::integer, 0) + 1)::text,
           updated_at = NOW()`
    );
  }

  async decrementActive(): Promise<void> {
    await this.pool.query(
      `UPDATE rate_limit_state
       SET value = GREATEST(0, COALESCE(value::integer, 1) - 1)::text,
           updated_at = NOW()
       WHERE key = 'active_count'`
    );
  }

  async enqueue(input: SpawnAgentInput): Promise<number> {
    const id = uuidv4();
    const priority = ROLE_PRIORITY[input.role] || 0;

    await this.pool.query(
      `INSERT INTO task_queue (id, role, project_id, task_id, prompt, repo_url, working_dir, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        input.role,
        input.projectId,
        input.taskId || null,
        input.prompt,
        input.repoUrl || null,
        input.workingDir || null,
        priority,
      ]
    );

    const result = await this.pool.query(
      `SELECT COUNT(*) as position FROM task_queue WHERE priority >= $1`,
      [priority]
    );
    return parseInt(result.rows[0].position, 10);
  }

  async processQueue(spawner: AgentSpawner): Promise<number> {
    if (!(await this.canSpawn())) {
      return 0;
    }

    const activeCount = await this.getActiveCount();
    const slotsAvailable = MAX_CONCURRENT_AGENTS - activeCount;

    const result = await this.pool.query(
      `SELECT * FROM task_queue ORDER BY priority DESC, created_at ASC LIMIT $1`,
      [slotsAvailable]
    );

    let processed = 0;

    for (const row of result.rows) {
      if (!(await this.canSpawn())) break;

      const task = parseRow(QueuedTaskSchema, row);

      try {
        await this.incrementActive();

        await spawner.spawn({
          role: task.role,
          projectId: task.projectId,
          taskId: task.taskId || undefined,
          prompt: task.prompt,
          repoUrl: task.repoUrl || undefined,
          workingDir: task.workingDir || undefined,
        });

        await this.pool.query(`DELETE FROM task_queue WHERE id = $1`, [task.id]);

        processed++;
        console.log(
          `Processed queued task ${task.id} (${task.role}, priority ${task.priority})`
        );
      } catch (err) {
        await this.decrementActive();
        const error = err as Error;

        if (error.message.includes("rate limit") || error.message.includes("429")) {
          await this.markRateLimited();
          break;
        }

        console.error(`Failed to process queued task ${task.id}:`, error.message);
      }
    }

    return processed;
  }

  async getQueue(): Promise<QueuedTask[]> {
    const result = await this.pool.query(
      `SELECT * FROM task_queue ORDER BY priority DESC, created_at ASC`
    );

    return parseRows(QueuedTaskSchema, result.rows);
  }

  async getQueueLength(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM task_queue`
    );
    return parseInt(result.rows[0].count, 10);
  }

  private async getActiveCount(): Promise<number> {
    const result = await this.pool.query(
      `SELECT value FROM rate_limit_state WHERE key = 'active_count'`
    );
    if (result.rows.length === 0) return 0;
    return parseInt(result.rows[0].value, 10);
  }

  private async getRateLimitedUntil(): Promise<Date | null> {
    const result = await this.pool.query(
      `SELECT value FROM rate_limit_state WHERE key = 'rate_limited_until'`
    );
    if (result.rows.length === 0) return null;
    const date = new Date(result.rows[0].value);
    return isNaN(date.getTime()) ? null : date;
  }

  private async clearRateLimit(): Promise<void> {
    await this.pool.query(
      `DELETE FROM rate_limit_state WHERE key = 'rate_limited_until'`
    );
  }
}
