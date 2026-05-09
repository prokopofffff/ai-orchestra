import { addSystemMessage, addTechLeadMessage } from "./conversation-api";
import { sendTelegramMessage } from "./notify";
import { getPool } from "./db";
import { log } from "./obs";

export type NotificationPriority = "high" | "normal" | "low";

export interface Notification {
  projectId: string;
  text: string;
  priority: NotificationPriority;
  metadata?: Record<string, unknown>;
  fromRole?: "tech-lead" | "system";
}

/**
 * Send a notification to the user through all available channels.
 * Messages are stored in Conversation API and pushed to Telegram if configured.
 */
export async function notify(notification: Notification): Promise<void> {
  const { projectId, text, fromRole = "system", metadata } = notification;

  // 1. Store in conversation
  if (fromRole === "tech-lead") {
    await addTechLeadMessage(projectId, text, metadata);
  } else {
    await addSystemMessage(projectId, text, metadata);
  }

  // 2. Push to Telegram (if configured)
  const telegramChatId = await getTelegramChatId(projectId);
  if (telegramChatId) {
    const sent = await sendTelegramMessage(telegramChatId, text);
    log.debug({ telegramChatId, sent, projectId }, "telegram notify");
  } else {
    log.debug({ projectId }, "telegram notify skipped: no chatId");
  }
}

/**
 * Notify about task state change.
 */
export async function notifyTaskStateChange(
  projectId: string,
  taskTitle: string,
  oldState: string,
  newState: string,
): Promise<void> {
  await notify({
    projectId,
    text: `Task "${taskTitle}" → ${newState}`,
    priority: "normal",
    metadata: { event: "task_state_change", oldState, newState },
  });
}

/**
 * Notify about PR ready for merge.
 */
export async function notifyPrReady(
  projectId: string,
  taskTitle: string,
  prUrl: string,
): Promise<void> {
  await notify({
    projectId,
    text: `PR одобрен, можешь мержить: ${taskTitle}\n${prUrl}`,
    priority: "high",
    fromRole: "tech-lead",
    metadata: { event: "pr_ready", prUrl },
  });
}

/**
 * Raise an escalation: writes a `system → user` signal with `action='escalate'`
 * and pushes a high-priority notification. Single entry point so call sites
 * (cost cap, revisions cap, signal cap, run timeout, …) don't duplicate the
 * INSERT + notify pair.
 */
export async function escalate(
  projectId: string,
  taskId: string | null,
  reason: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const payload = { message: reason, ...(metadata ?? {}) };
  await getPool().query(
    `INSERT INTO signals (project_id, task_id, from_role, to_role, action, payload)
     VALUES ($1, $2, 'system', 'user', 'escalate', $3)`,
    [projectId, taskId, JSON.stringify(payload)],
  );
  await notify({
    projectId,
    text: `⚠ ${reason}`,
    priority: "high",
    fromRole: "system",
    metadata: { event: "escalation", taskId, ...(metadata ?? {}) },
  });
}

/**
 * Notify about escalation.
 */
export async function notifyEscalation(
  projectId: string,
  fromRole: string,
  message: string,
): Promise<void> {
  await notify({
    projectId,
    text: `⚠ Escalation от ${fromRole}: ${message}`,
    priority: "high",
    metadata: { event: "escalation", fromRole },
  });
}

/**
 * Notify about agent spawned/finished.
 */
export async function notifyAgentEvent(
  projectId: string,
  role: string,
  event: "spawned" | "finished" | "crashed",
  taskTitle?: string,
): Promise<void> {
  const msgs: Record<string, string> = {
    spawned: `Agent ${role} started${taskTitle ? `: ${taskTitle}` : ""}`,
    finished: `Agent ${role} finished${taskTitle ? `: ${taskTitle}` : ""}`,
    crashed: `Agent ${role} crashed${taskTitle ? ` on: ${taskTitle}` : ""}`,
  };

  await notify({
    projectId,
    text: msgs[event],
    priority: event === "crashed" ? "high" : "low",
    metadata: { event: `agent_${event}`, role },
  });
}

// ─── Helpers ───

async function getTelegramChatId(projectId: string): Promise<string | null> {
  // Check if any telegram user has this project as active
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT chat_id FROM telegram_users WHERE active_project_id = $1 LIMIT 1",
    [projectId],
  );
  if (rows.length) return rows[0].chat_id;

  // Fallback to global TELEGRAM_CHAT_ID
  return process.env.TELEGRAM_CHAT_ID || null;
}
