import { sendTelegramMessage } from "./notify";
import { handleTelegramMessage, handleTelegramCommand } from "./telegram-handler";

let polling = false;
let offset = 0;

export function startTelegramPolling(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  polling = true;
  console.log("Telegram polling started");
  poll(token);
}

export function stopTelegramPolling(): void {
  polling = false;
}

async function poll(token: string): Promise<void> {
  while (polling) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30`,
        { signal: AbortSignal.timeout(35000) },
      );
      const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          await handleUpdate(update);
        }
      }
    } catch (err) {
      if (polling) {
        console.error("Telegram poll error:", (err as Error).message);
        await sleep(5000);
      }
    }
  }
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message?.text) return;

  const chatId = String(message.chat.id);
  const text = message.text;

  if (text.startsWith("/")) {
    await handleTelegramCommand(chatId, text);
  } else {
    await handleTelegramMessage(chatId, text, message.message_id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
