import { getPool } from "./db";
import {
  getActiveSessions,
  updateSession,
  type Session,
} from "./session-manager";
import { enqueue } from "./rate-limiter";
import { loadConfig } from "./config";
import { notify } from "./notification-hub";
import { appendLog } from "./logger";
import { logBackgroundError } from "./error-handler";

const CHECK_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 10 * 60_000; // 10 minutes no heartbeat
const TECH_LEAD_MAX_AGE_MS = 8 * 60 * 60_000; // 8 hours session timeout

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 30_000; // 30s, 60s, 120s

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startHeartbeat(): void {
  if (intervalId) return;
  intervalId = setInterval(() => checkSessions().catch((e) => logBackgroundError("heartbeat", e)), CHECK_INTERVAL_MS);
  console.log("Heartbeat monitor started (every 30s)");
}

export function stopHeartbeat(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export interface SessionHealth {
  sessionId: string;
  role: string;
  status: "healthy" | "crashed" | "hung";
  reason?: string;
}

export async function checkSessions(): Promise<SessionHealth[]> {
  const sessions = await getActiveSessions();
  const results: SessionHealth[] = [];

  for (const session of sessions) {
    const health = checkSessionHealth(session);
    results.push(health);

    if (health.status === "crashed" || health.status === "hung") {
      await handleUnhealthy(session, health);
    }
  }

  return results;
}

function checkSessionHealth(session: Session): SessionHealth {
  const base = { sessionId: session.id, role: session.role };

  // Check if process is alive
  if (session.pid) {
    try {
      process.kill(session.pid, 0);
    } catch {
      return { ...base, status: "crashed", reason: "Process not found" };
    }
  }

  // Check for stale session
  if (session.lastHeartbeat) {
    const elapsed = Date.now() - session.lastHeartbeat.getTime();
    if (elapsed > STALE_THRESHOLD_MS) {
      return { ...base, status: "hung", reason: `No heartbeat for ${Math.round(elapsed / 60000)}m` };
    }
  }

  // Tech Lead session age check
  if (session.role === "tech-lead") {
    const age = Date.now() - session.startedAt.getTime();
    if (age > TECH_LEAD_MAX_AGE_MS) {
      return { ...base, status: "hung", reason: "Tech Lead session exceeded 8h — context likely degraded" };
    }
  }

  return { ...base, status: "healthy" };
}

async function handleUnhealthy(session: Session, health: SessionHealth): Promise<void> {
  const pool = getPool();
  const projectId = session.projectId;

  // Get retry count from queue history
  const { rows } = await pool.query(
    "SELECT retry_count FROM task_queue WHERE task_id = $1 AND role = $2 ORDER BY created_at DESC LIMIT 1",
    [session.taskId, session.role],
  );
  const retryCount = rows[0]?.retry_count ?? 0;

  appendLog(projectId, session.id, session.role, "error",
    `Agent ${health.status}: ${health.reason} (retry ${retryCount}/${MAX_RETRIES})`);

  // Tech Lead context overflow — special handling: fresh session, no retry counting
  if (session.role === "tech-lead" && health.reason?.includes("context")) {
    await updateSession(session.id, { status: "terminated", finishedAt: new Date() });
    appendLog(projectId, session.id, "tech-lead", "system", "Context overflow — spawning fresh session");

    const config = loadConfig();
    const { rows: taskRows } = await pool.query(
      `SELECT id FROM tasks WHERE project_id = $1 AND assignee_role = 'tech-lead'
       AND state NOT IN ('merged', 'closed') ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    const taskId = taskRows[0]?.id ?? session.taskId;
    if (taskId) {
      await enqueue({ projectId, taskId, role: "tech-lead", config, retryCount: 0 });
    }
    return;
  }

  // Max retries exceeded — mark failed and escalate
  if (retryCount >= MAX_RETRIES) {
    await updateSession(session.id, { status: "crashed", finishedAt: new Date() });

    const message = `Agent ${session.role} failed permanently after ${retryCount} retries: ${health.reason}`;
    console.error(`[heartbeat] ${message}`);
    appendLog(projectId, session.id, session.role, "error", message);

    // Escalate to user
    await notify({
      projectId,
      text: `Agent ${session.role} crashed and could not recover after ${retryCount} retries.\nReason: ${health.reason}\nManual intervention may be needed.`,
      priority: "high",
      fromRole: "system",
    }).catch((e) => logBackgroundError("heartbeat:notify", e, projectId));

    // Store escalation signal
    if (session.taskId) {
      await pool.query(
        `INSERT INTO signals (project_id, task_id, from_role, to_role, action, payload)
         VALUES ($1, $2, 'system', 'user', 'escalate', $3)`,
        [projectId, session.taskId, JSON.stringify({ message })],
      );
    }
    return;
  }

  // Retry with exponential backoff
  await updateSession(session.id, { status: "crashed", finishedAt: new Date() });

  const nextRetry = retryCount + 1;
  const backoffMs = BACKOFF_BASE_MS * Math.pow(2, retryCount); // 30s, 60s, 120s
  const backoffSec = Math.round(backoffMs / 1000);

  appendLog(projectId, session.id, session.role, "system",
    `Scheduling retry ${nextRetry}/${MAX_RETRIES} in ${backoffSec}s (exponential backoff)`);

  // Notify user about retry (only on 2nd+ retry)
  if (nextRetry >= 2) {
    await notify({
      projectId,
      text: `Agent ${session.role} crashed (attempt ${nextRetry}/${MAX_RETRIES}). Retrying in ${backoffSec}s...`,
      priority: "normal",
      fromRole: "system",
    }).catch((e) => logBackgroundError("heartbeat:notify", e, projectId));
  }

  // Schedule retry after backoff delay
  setTimeout(async () => {
    if (!session.taskId) return;
    try {
      const config = loadConfig();
      await enqueue({
        projectId,
        taskId: session.taskId,
        role: session.role,
        config,
        resumeSessionId: session.claudeSessionId ?? undefined,
        retryCount: nextRetry,
      });
      appendLog(projectId, null, session.role, "system",
        `Retry ${nextRetry}/${MAX_RETRIES} enqueued for task ${session.taskId}`);
    } catch (e) {
      logBackgroundError("heartbeat:retry-enqueue", e, projectId);
    }
  }, backoffMs);
}
