import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { OrchestraConfig } from "./config.js";
import { AgentRoleSchema, type AgentRole } from "./session-manager.js";
import type { AgentSpawner, SpawnAgentInput } from "./agent-spawner.js";

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
  private activeCount = 0;
  private rateLimitedUntil: Date | null = null;

  constructor(config: OrchestraConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl });
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
  }

  async canSpawn(): Promise<boolean> {
    // Check concurrent limit
    if (this.activeCount >= MAX_CONCURRENT_AGENTS) {
      return false;
    }

    // Check rate limit cooldown
    if (this.rateLimitedUntil && new Date() < this.rateLimitedUntil) {
      return false;
    }

    this.rateLimitedUntil = null;
    return true;
  }

  markRateLimited(retryAfterMs: number = 5 * 60 * 1000): void {
    this.rateLimitedUntil = new Date(Date.now() + retryAfterMs);
    console.log(
      `Rate limited until ${this.rateLimitedUntil.toISOString()}`
    );
  }

  incrementActive(): void {
    this.activeCount++;
  }

  decrementActive(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
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

    // Return queue position
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

    // Get highest priority queued tasks
    const result = await this.pool.query(
      `SELECT * FROM task_queue ORDER BY priority DESC, created_at ASC LIMIT $1`,
      [MAX_CONCURRENT_AGENTS - this.activeCount]
    );

    let processed = 0;

    for (const row of result.rows) {
      if (!(await this.canSpawn())) break;

      const task = QueuedTaskSchema.parse({
        id: row.id,
        role: row.role,
        projectId: row.project_id,
        taskId: row.task_id,
        prompt: row.prompt,
        repoUrl: row.repo_url,
        workingDir: row.working_dir,
        priority: row.priority,
        createdAt: row.created_at,
      });

      try {
        this.incrementActive();

        await spawner.spawn({
          role: task.role,
          projectId: task.projectId,
          taskId: task.taskId || undefined,
          prompt: task.prompt,
          repoUrl: task.repoUrl || undefined,
          workingDir: task.workingDir || undefined,
        });

        // Remove from queue
        await this.pool.query(`DELETE FROM task_queue WHERE id = $1`, [
          task.id,
        ]);

        processed++;
        console.log(
          `Processed queued task ${task.id} (${task.role}, priority ${task.priority})`
        );
      } catch (err) {
        this.decrementActive();
        const error = err as Error;

        if (error.message.includes("rate limit") || error.message.includes("429")) {
          this.markRateLimited();
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

    return result.rows.map((row) =>
      QueuedTaskSchema.parse({
        id: row.id,
        role: row.role,
        projectId: row.project_id,
        taskId: row.task_id,
        prompt: row.prompt,
        repoUrl: row.repo_url,
        workingDir: row.working_dir,
        priority: row.priority,
        createdAt: row.created_at,
      })
    );
  }

  async getQueueLength(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM task_queue`
    );
    return parseInt(result.rows[0].count, 10);
  }
}
