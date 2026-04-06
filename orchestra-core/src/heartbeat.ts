import { getPool } from "./db";
import {
  getActiveSessions,
  updateSession,
  getSession,
  type Session,
} from "./session-manager";
import { enqueue } from "./rate-limiter";
import { loadConfig } from "./config";

const CHECK_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 10 * 60_000; // 10 minutes
const TECH_LEAD_MAX_AGE_MS = 8 * 60 * 60_000; // 8 hours — session timeout

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startHeartbeat(): void {
  if (intervalId) return;
  intervalId = setInterval(checkSessions, CHECK_INTERVAL_MS);
  console.log("Heartbeat monitor started (every 30s)");
}

export function stopHeartbeat(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export async function checkSessions(): Promise<SessionHealth[]> {
  const sessions = await getActiveSessions();
  const results: SessionHealth[] = [];

  for (const session of sessions) {
    const health = await checkSession(session);
    results.push(health);

    if (health.status === "crashed" || health.status === "hung") {
      await handleUnhealthy(session, health);
    }
  }

  return results;
}

export interface SessionHealth {
  sessionId: string;
  role: string;
  status: "healthy" | "crashed" | "hung";
  reason?: string;
}

async function checkSession(session: Session): Promise<SessionHealth> {
  const base = { sessionId: session.id, role: session.role };

  // Check if process is alive
  if (session.pid) {
    try {
      process.kill(session.pid, 0); // Signal 0 = check if process exists
    } catch {
      return { ...base, status: "crashed", reason: "Process not found" };
    }
  }

  // Check for stale session (no heartbeat for too long)
  if (session.lastHeartbeat) {
    const elapsed = Date.now() - session.lastHeartbeat.getTime();
    if (elapsed > STALE_THRESHOLD_MS) {
      return { ...base, status: "hung", reason: `No heartbeat for ${Math.round(elapsed / 60000)}m` };
    }
  }

  // Tech Lead session age check (A model: 8h timeout)
  if (session.role === "tech-lead") {
    const age = Date.now() - session.startedAt.getTime();
    if (age > TECH_LEAD_MAX_AGE_MS) {
      return { ...base, status: "hung", reason: `Tech Lead session exceeded ${TECH_LEAD_MAX_AGE_MS / 3600000}h — context likely degraded` };
    }
  }

  return { ...base, status: "healthy" };
}

async function handleUnhealthy(session: Session, health: SessionHealth): Promise<void> {
  const pool = getPool();

  // Check retry count
  const { rows } = await pool.query(
    "SELECT retry_count FROM task_queue WHERE task_id = $1 AND role = $2 ORDER BY created_at DESC LIMIT 1",
    [session.taskId, session.role],
  );
  const retryCount = rows[0]?.retry_count ?? 0;

  if (retryCount >= 2) {
    // Max retries reached — mark as crashed, escalate to user
    await updateSession(session.id, { status: "crashed", finishedAt: new Date() });
    console.error(`Agent ${session.role} (session ${session.id}) failed after ${retryCount} retries. Escalating.`);

    // Create escalation signal
    if (session.taskId) {
      await pool.query(
        `INSERT INTO signals (project_id, task_id, from_role, to_role, action, payload)
         VALUES ($1, $2, 'system', 'user', 'escalate', $3)`,
        [
          session.projectId,
          session.taskId,
          JSON.stringify({ message: `Agent ${session.role} crashed after ${retryCount} retries: ${health.reason}` }),
        ],
      );
    }
    return;
  }

  // Mark current session as crashed/terminated
  const newStatus = session.role === "tech-lead" && health.reason?.includes("context") ? "terminated" : "crashed";
  await updateSession(session.id, { status: newStatus, finishedAt: new Date() });

  // For Tech Lead context overflow: create fresh session with full bootstrap (no resume)
  if (session.role === "tech-lead" && newStatus === "terminated") {
    console.log(`Tech Lead session ${session.id} context overflow — spawning fresh session with bootstrap`);
    const config = loadConfig();
    // Find the current epic/active task for tech-lead
    const { rows: taskRows } = await pool.query(
      `SELECT id FROM tasks WHERE project_id = $1 AND assignee_role = 'tech-lead' AND state NOT IN ('merged', 'closed') ORDER BY created_at DESC LIMIT 1`,
      [session.projectId],
    );
    const taskId = taskRows[0]?.id ?? session.taskId;
    if (taskId) {
      await enqueue({
        projectId: session.projectId,
        taskId,
        role: "tech-lead",
        config,
        // No resumeSessionId — fresh session with bootstrap context
        retryCount: 0,
      });
    }
    return;
  }

  // Re-enqueue for retry (resume first approach)
  if (session.taskId) {
    const config = loadConfig();
    await enqueue({
      projectId: session.projectId,
      taskId: session.taskId,
      role: session.role,
      config,
      resumeSessionId: session.claudeSessionId ?? undefined,
      retryCount: retryCount + 1,
    });

    console.log(`Re-enqueued ${session.role} for task ${session.taskId} (retry ${retryCount + 1})`);
  }
}
