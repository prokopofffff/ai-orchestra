import { spawn, ChildProcess } from "node:child_process";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { OrchestraConfig } from "./config.js";
import { parseRow, parseRows } from "./db-utils.js";

export const AgentRoleSchema = z.enum([
  "tech-lead",
  "designer",
  "frontend",
  "backend",
  "qa",
  "devops",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const SessionStatusSchema = z.enum([
  "running",
  "sleeping",
  "terminated",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const AgentSessionSchema = z.object({
  id: z.string().uuid(),
  role: AgentRoleSchema,
  projectId: z.string(),
  claudeSessionId: z.string().nullable(),
  createdAt: z.coerce.date(),
  lastActiveAt: z.coerce.date(),
  status: SessionStatusSchema,
  taskId: z.string().nullable(),
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const CreateSessionInputSchema = z.object({
  role: AgentRoleSchema,
  projectId: z.string().min(1),
  taskId: z.string().optional(),
});

export const LaunchAgentInputSchema = z.object({
  prompt: z.string().min(1),
  workingDir: z.string().min(1),
});

const SESSION_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours

/**
 * Schema for Claude CLI JSON output.
 * Claude CLI with --output-format json returns an array of message objects.
 * The session_id is available in the top-level response metadata.
 */
const ClaudeJsonOutputSchema = z.object({
  session_id: z.string().optional(),
}).passthrough();

const ClaudeJsonArraySchema = z.array(
  z.object({
    type: z.string().optional(),
    session_id: z.string().optional(),
  }).passthrough()
);

function extractSessionId(stdout: string): string | null {
  // Try parsing as JSON first (structured output)
  try {
    // Claude CLI may output a single JSON object or an array
    const parsed = JSON.parse(stdout);

    if (Array.isArray(parsed)) {
      const validated = ClaudeJsonArraySchema.safeParse(parsed);
      if (validated.success) {
        // session_id is typically on the last message or a system message
        for (const msg of validated.data) {
          if (msg.session_id) return msg.session_id;
        }
      }
    } else {
      const validated = ClaudeJsonOutputSchema.safeParse(parsed);
      if (validated.success && validated.data.session_id) {
        return validated.data.session_id;
      }
    }
  } catch {
    // Not valid JSON — may be mixed output, try JSONL
  }

  // Try JSONL (one JSON object per line)
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;

    try {
      const obj = ClaudeJsonOutputSchema.safeParse(JSON.parse(trimmed));
      if (obj.success && obj.data.session_id) {
        return obj.data.session_id;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export class SessionManager {
  private pool: Pool;
  private config: OrchestraConfig;
  private activeProcesses = new Map<string, ChildProcess>();

  constructor(config: OrchestraConfig, pool: Pool) {
    this.config = config;
    this.pool = pool;
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        project_id TEXT NOT NULL,
        claude_session_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_active_at TIMESTAMPTZ DEFAULT NOW(),
        status TEXT DEFAULT 'running',
        task_id TEXT
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS signal_queue (
        id TEXT PRIMARY KEY,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        action TEXT NOT NULL,
        context JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        processed BOOLEAN DEFAULT FALSE
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
        meta JSONB DEFAULT '{}'
      )
    `);
  }

  async shouldResume(
    role: AgentRole,
    projectId: string
  ): Promise<AgentSession | null> {
    const result = await this.pool.query(
      `SELECT * FROM agent_sessions
       WHERE role = $1 AND project_id = $2 AND status != 'terminated'
       ORDER BY last_active_at DESC LIMIT 1`,
      [role, projectId]
    );

    if (result.rows.length === 0) return null;

    const session = parseRow(AgentSessionSchema, result.rows[0]);
    const age = Date.now() - session.lastActiveAt.getTime();

    if (age > SESSION_TIMEOUT_MS) {
      await this.terminateSession(session.id);
      return null;
    }

    return session;
  }

  async createSession(
    role: AgentRole,
    projectId: string,
    taskId?: string
  ): Promise<AgentSession> {
    const input = CreateSessionInputSchema.parse({ role, projectId, taskId });
    const id = uuidv4();

    const result = await this.pool.query(
      `INSERT INTO agent_sessions (id, role, project_id, task_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, input.role, input.projectId, input.taskId || null]
    );
    return parseRow(AgentSessionSchema, result.rows[0]);
  }

  async launchAgent(
    session: AgentSession,
    prompt: string,
    workingDir: string,
    mcpConfigPath?: string
  ): Promise<{ output: string; claudeSessionId: string | null }> {
    const input = LaunchAgentInputSchema.parse({ prompt, workingDir });
    const args = this.buildClaudeArgs(session, input.prompt, mcpConfigPath);

    return new Promise((resolve, reject) => {
      const proc = spawn(this.config.claude.cliPath, args, {
        cwd: input.workingDir,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.activeProcesses.set(session.id, proc);
      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", async (code) => {
        this.activeProcesses.delete(session.id);

        const claudeSessionId =
          extractSessionId(stdout) || session.claudeSessionId;

        await this.pool.query(
          `UPDATE agent_sessions
           SET status = 'sleeping', last_active_at = NOW(), claude_session_id = $2
           WHERE id = $1`,
          [session.id, claudeSessionId]
        );

        if (code !== 0 && code !== null) {
          reject(
            new Error(
              `Claude exited with code ${code}: ${stderr || stdout}`
            )
          );
          return;
        }

        resolve({ output: stdout, claudeSessionId });
      });

      proc.on("error", (err) => {
        this.activeProcesses.delete(session.id);
        reject(err);
      });
    });
  }

  private buildClaudeArgs(session: AgentSession, prompt: string, mcpConfigPath?: string): string[] {
    const args: string[] = [];

    if (session.claudeSessionId) {
      args.push("--resume", session.claudeSessionId);
    } else {
      args.push(
        "--system-prompt",
        this.getSystemPromptPath(session.role),
        "--dangerously-skip-permissions"
      );
    }

    args.push(
      "--mcp-config",
      mcpConfigPath || "/app/mcp-tools/mcp-config.json",
      "--print",
      "--output-format",
      "json",
      "-p",
      prompt
    );

    return args;
  }

  private getSystemPromptPath(role: AgentRole): string {
    const promptFiles: Record<AgentRole, string> = {
      "tech-lead": "/app/prompts/tech-lead.md",
      designer: "/app/prompts/designer.md",
      frontend: "/app/prompts/dev-frontend.md",
      backend: "/app/prompts/dev-backend.md",
      qa: "/app/prompts/qa.md",
      devops: "/app/prompts/devops.md",
    };
    return promptFiles[role];
  }

  async terminateSession(sessionId: string): Promise<void> {
    const proc = this.activeProcesses.get(sessionId);
    if (proc) {
      proc.kill("SIGTERM");
      this.activeProcesses.delete(sessionId);
    }

    await this.pool.query(
      `UPDATE agent_sessions SET status = 'terminated' WHERE id = $1`,
      [sessionId]
    );
  }

  /**
   * Graceful shutdown: kill all active child processes,
   * mark their sessions as 'sleeping' so they can be resumed after restart.
   */
  async shutdownAll(): Promise<number> {
    const sessionIds = Array.from(this.activeProcesses.keys());

    if (sessionIds.length === 0) return 0;

    console.log(`Shutting down ${sessionIds.length} active agent(s)...`);

    // Send SIGTERM to all child processes
    for (const [sessionId, proc] of this.activeProcesses) {
      try {
        proc.kill("SIGTERM");
        console.log(`  Sent SIGTERM to session ${sessionId} (pid ${proc.pid})`);
      } catch {
        // Process may have already exited
      }
    }

    // Wait briefly for processes to exit gracefully
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Force kill any remaining processes
    for (const [sessionId, proc] of this.activeProcesses) {
      try {
        if (!proc.killed) {
          proc.kill("SIGKILL");
          console.log(`  Force killed session ${sessionId}`);
        }
      } catch {
        // Already dead
      }
    }

    this.activeProcesses.clear();

    // Mark all running sessions as sleeping (resumable after restart)
    const result = await this.pool.query(
      `UPDATE agent_sessions
       SET status = 'sleeping', last_active_at = NOW()
       WHERE status = 'running'
       RETURNING id`
    );

    const updated = result.rowCount || 0;
    console.log(`Marked ${updated} running session(s) as sleeping`);

    return updated;
  }

  get activeProcessCount(): number {
    return this.activeProcesses.size;
  }

  async getSession(sessionId: string): Promise<AgentSession | null> {
    const result = await this.pool.query(
      `SELECT * FROM agent_sessions WHERE id = $1`,
      [sessionId]
    );
    if (result.rows.length === 0) return null;
    return parseRow(AgentSessionSchema, result.rows[0]);
  }

  async listSessions(projectId?: string): Promise<AgentSession[]> {
    const query = projectId
      ? {
          text: `SELECT * FROM agent_sessions WHERE project_id = $1 ORDER BY last_active_at DESC`,
          values: [projectId],
        }
      : {
          text: `SELECT * FROM agent_sessions ORDER BY last_active_at DESC`,
          values: [] as string[],
        };

    const result = await this.pool.query(query);
    return parseRows(AgentSessionSchema, result.rows);
  }

  async cleanupStaleSessions(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE agent_sessions
       SET status = 'terminated'
       WHERE status != 'terminated'
         AND last_active_at < NOW() - INTERVAL '8 hours'
       RETURNING id`
    );
    return result.rowCount || 0;
  }

}
