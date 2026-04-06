import { z } from "zod";
import { getPool } from "./db";
import { parseRows } from "./db-utils";

export type LogLevel = "stdout" | "stderr" | "system" | "error";

const logEntrySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  sessionId: z.string().uuid().nullable(),
  role: z.string(),
  level: z.enum(["stdout", "stderr", "system", "error"]),
  message: z.string(),
  createdAt: z.coerce.date(),
});

export type LogEntry = z.infer<typeof logEntrySchema>;

/**
 * Append a log entry. Non-blocking — errors are silently ignored.
 */
export function appendLog(
  projectId: string,
  sessionId: string | null,
  role: string,
  level: LogLevel,
  message: string,
): void {
  getPool().query(
    `INSERT INTO agent_logs (project_id, session_id, role, level, message)
     VALUES ($1, $2, $3, $4, $5)`,
    [projectId, sessionId, role, level, message],
  ).catch((e) => { console.error(`[logger] Failed to write log: ${e instanceof Error ? e.message : e}`); });
}

/**
 * Fetch logs for a project, optionally filtered by session or role.
 */
export async function getLogs(
  projectId: string,
  options?: { sessionId?: string; role?: string; level?: LogLevel; limit?: number },
): Promise<LogEntry[]> {
  const pool = getPool();
  const wheres = ["project_id = $1"];
  const vals: unknown[] = [projectId];
  let i = 2;

  if (options?.sessionId) { wheres.push(`session_id = $${i++}`); vals.push(options.sessionId); }
  if (options?.role) { wheres.push(`role = $${i++}`); vals.push(options.role); }
  if (options?.level) { wheres.push(`level = $${i++}`); vals.push(options.level); }

  const limit = Math.min(options?.limit ?? 200, 1000);
  vals.push(limit);

  const { rows } = await pool.query(
    `SELECT id, project_id, session_id, role, level, message, created_at
     FROM agent_logs
     WHERE ${wheres.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${i}`,
    vals,
  );

  return parseRows(logEntrySchema, rows);
}
