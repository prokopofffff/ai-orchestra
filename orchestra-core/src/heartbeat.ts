import { z } from "zod";
import { getPool } from "./db";
import {
  getActiveSessions,
  updateSession,
  type Session,
} from "./session-manager";
import { enqueue, getRetryCount } from "./rate-limiter";
import { loadConfig } from "./config";
import { notify } from "./notification-hub";
import { appendLog } from "./logger";
import { logBackgroundError } from "./error-handler";
import { registerHandler, registerCron, enqueue as enqueueJob } from "./scheduler";
import { log } from "./obs";

const STALE_THRESHOLD_MS = 10 * 60_000; // 10 minutes no heartbeat
const TECH_LEAD_MAX_AGE_MS = 8 * 60 * 60_000; // 8 hours session timeout

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 30_000; // 30s, 60s, 120s

const HEARTBEAT_KIND = "heartbeat:check-sessions";
const AGENT_RETRY_KIND = "heartbeat:agent-retry";

const AgentRetryPayload = z.object({
  projectId: z.string(),
  taskId: z.string(),
  role: z.enum(["tech-lead", "designer", "frontend", "backend", "qa", "devops"]),
  resumeSessionId: z.string().optional(),
  retryCount: z.number().int().min(1),
  totalRetries: z.number().int().min(1),
});

registerHandler(HEARTBEAT_KIND, z.object({}), async () => {
  await checkSessions().catch((e) => logBackgroundError("heartbeat", e));
});

registerHandler(AGENT_RETRY_KIND, AgentRetryPayload, async (p) => {
  const config = loadConfig();
  await enqueue({
    projectId: p.projectId,
    taskId: p.taskId,
    role: p.role,
    config,
    resumeSessionId: p.resumeSessionId,
    retryCount: p.retryCount,
  });
  appendLog(p.projectId, null, p.role, "system",
    `Retry ${p.retryCount}/${p.totalRetries} enqueued for task ${p.taskId}`);
});

export async function startHeartbeat(): Promise<void> {
  await registerCron({
    key: "heartbeat",
    kind: HEARTBEAT_KIND,
    intervalSeconds: 30,
  });
  log.info("heartbeat monitor scheduled (every 30s)");
}

// Kept for compatibility with shutdown sequence — scheduler stop handles teardown.
export function stopHeartbeat(): void {}

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

export function checkSessionHealth(session: Session): SessionHealth {
  const base = { sessionId: session.id, role: session.role };

  // Agents run in-process via the Agent SDK. A crashed orchestrator can't run
  // this check anyway — its scheduler job lease expires and graphile-worker
  // re-claims. Here we only detect stuck sessions via heartbeat staleness +
  // age.

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

  // Retry count = attempts on the most recent agent-run job for (taskId, role)
  const retryCount = session.taskId
    ? await getRetryCount(session.taskId, session.role)
    : 0;

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
    log.error({ role: session.role, retries: retryCount, reason: health.reason, projectId, taskId: session.taskId }, "agent permanently failed");
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

  // Schedule retry as a deferred scheduler job (survives process restart).
  if (session.taskId) {
    await enqueueJob({
      kind: AGENT_RETRY_KIND,
      runAt: new Date(Date.now() + backoffMs),
      payload: {
        projectId,
        taskId: session.taskId,
        role: session.role,
        resumeSessionId: session.claudeSessionId ?? undefined,
        retryCount: nextRetry,
        totalRetries: MAX_RETRIES,
      },
    }).catch((e) => logBackgroundError("heartbeat:retry-enqueue", e, projectId));
  }
}
