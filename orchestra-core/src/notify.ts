import { log } from "./obs";

const TG_MAX_LENGTH = 4096;

function getToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN;
}

/**
 * Send a message via Telegram Bot API.
 * Silently fails if no token configured.
 * Splits long messages and falls back to plain text if Markdown parsing fails.
 */
export async function sendTelegramMessage(chatId: string, text: string): Promise<boolean> {
  if (!getToken()) return false;

  // Split long messages
  const chunks = splitMessage(text, TG_MAX_LENGTH);
  let allOk = true;

  for (const chunk of chunks) {
    const ok = await sendChunk(chatId, chunk);
    if (!ok) allOk = false;
  }

  return allOk;
}

async function sendChunk(chatId: string, text: string): Promise<boolean> {
  try {
    // Try with Markdown first
    let res = await fetch(`https://api.telegram.org/bot${getToken()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });

    if (!res.ok) {
      // Fallback: send without parse_mode
      res = await fetch(`https://api.telegram.org/bot${getToken()}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    }

    if (!res.ok) {
      const body = await res.json();
      log.error({ status: res.status, body }, "telegram send failed");
      return false;
    }

    return true;
  } catch (err) {
    log.error({ err }, "telegram send error");
    return false;
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Split at last newline before limit
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen; // No good newline, hard split
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
