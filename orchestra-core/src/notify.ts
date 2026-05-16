import { log } from "./obs";

const TG_MAX_LENGTH = 4096;

/**
 * Send a message via the Telegram Bot API using a per-project token.
 * Silently no-ops if either token or chat is empty (lets callers funnel
 * "Telegram off for this project" through the same path as a successful
 * send). Splits long messages, retries without Markdown when parse fails.
 */
export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<boolean> {
  if (!token || !chatId) return false;

  const chunks = splitMessage(text, TG_MAX_LENGTH);
  let allOk = true;
  for (const chunk of chunks) {
    const ok = await sendChunk(token, chatId, chunk);
    if (!ok) allOk = false;
  }
  return allOk;
}

async function sendChunk(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    let res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
    if (!res.ok) {
      res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
