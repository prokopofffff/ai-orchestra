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

  // 2. Push to Telegram if this project has a bot + chat configured.
  // Per-project: each project has its own bot token and bound chat, so
  // we read both off settings.telegram. Missing either = silent skip.
  const tg = await getProjectTelegram(projectId);
  if (tg) {
    const sent = await sendTelegramMessage(tg.botToken, tg.chatId, text);
    log.debug({ chatId: tg.chatId, sent, projectId }, "telegram notify");
  } else {
    log.debug({ projectId }, "telegram notify skipped: not configured");
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

/**
 * Read a project's Telegram config — both bot token and bound chat have
 * to be present for outbound notifications. Returns null otherwise so
 * the caller's `if (tg)` branch handles "not configured".
 */
export async function getProjectTelegram(
  projectId: string,
): Promise<{ botToken: string; chatId: string } | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT settings -> 'telegram' ->> 'botToken'  AS bot_token,
            settings -> 'telegram' ->> 'chatId'    AS chat_id
       FROM projects WHERE id = $1`,
    [projectId],
  );
  const r = rows[0] as { bot_token?: string; chat_id?: string } | undefined;
  if (!r?.bot_token || !r.chat_id) return null;
  return { botToken: r.bot_token, chatId: r.chat_id };
}
