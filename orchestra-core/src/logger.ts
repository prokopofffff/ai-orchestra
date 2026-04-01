import { getPool } from "./db.js";

export type LogLevel = "stdout" | "stderr" | "system" | "error";

export interface LogEntry {
  id: string;
  projectId: string;
  sessionId: string | null;
  role: string;
  level: LogLevel;
  message: string;
  createdAt: string;
}

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
  ).catch(() => { /* ignore — logging should never crash the app */ });
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

  return rows.map((r) => ({
    id: r.id as string,
    projectId: r.project_id as string,
    sessionId: r.session_id as string | null,
    role: r.role as string,
    level: r.level as LogLevel,
    message: r.message as string,
    createdAt: (r.created_at as Date).toISOString(),
  }));
}
