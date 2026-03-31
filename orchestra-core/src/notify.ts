import { z } from "zod";
import { OrchestraConfig } from "./config.js";

const TELEGRAM_API = "https://api.telegram.org";

export const TelegramMessageSchema = z.object({
  chat_id: z.string().min(1),
  text: z.string().min(1),
  parse_mode: z.enum(["Markdown", "MarkdownV2", "HTML"]).optional(),
});

export async function notifyUser(
  config: OrchestraConfig,
  message?: string
): Promise<boolean> {
  if (!message) return false;

  if (config.telegram.botToken && config.telegram.chatId) {
    return sendTelegram(config.telegram.botToken, config.telegram.chatId, message);
  }

  // Fallback: log to console
  console.log(`[NOTIFY USER]: ${message}`);
  return false;
}

/**
 * Send a message mirroring agent communication to the user.
 */
export async function mirrorToUser(
  config: OrchestraConfig,
  from: string,
  to: string,
  action: string,
  message?: string
): Promise<boolean> {
  const formatted = `[${from} → ${to}] ${action}${message ? `: ${message}` : ""}`;
  return notifyUser(config, formatted);
}

async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string
): Promise<boolean> {
  try {
    const payload = TelegramMessageSchema.parse({
      chat_id: chatId,
      text,
    });

    const response = await fetch(
      `${TELEGRAM_API}/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    if (response.ok) {
      return true;
    }

    const err = await response.text();
    console.warn(`Telegram API error ${response.status}: ${err}`);
    return false;
  } catch (err) {
    console.warn("Failed to send Telegram message:", (err as Error).message);
    return false;
  }
}

/**
 * Get bot info and extract chat_id from first incoming message.
 * Useful for initial setup to discover the user's chat_id.
 */
export async function getTelegramUpdates(
  botToken: string
): Promise<Array<{ chatId: string; username: string; text: string }>> {
  try {
    const response = await fetch(
      `${TELEGRAM_API}/bot${botToken}/getUpdates?limit=10`
    );

    if (!response.ok) return [];

    const data = (await response.json()) as {
      result: Array<{
        message?: {
          chat: { id: number };
          from?: { username?: string };
          text?: string;
        };
      }>;
    };

    return (data.result || [])
      .filter((u) => u.message)
      .map((u) => ({
        chatId: String(u.message!.chat.id),
        username: u.message!.from?.username || "unknown",
        text: u.message!.text || "",
      }));
  } catch {
    return [];
  }
}
