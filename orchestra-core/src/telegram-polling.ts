import { getPool } from "./db.js";
import { dispatchTechLead } from "./tech-lead-dispatcher.js";
import { loadConfig } from "./config.js";
import { background } from "./error-handler.js";
import { sendTelegramMessage } from "./notify.js";

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
    from?: { first_name?: string };
  };
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message?.text) return;

  const chatId = String(message.chat.id);
  const text = message.text;
  const pool = getPool();

  // Handle commands
  if (text.startsWith("/")) {
    await handleCommand(chatId, text);
    return;
  }

  // Get active project
  const { rows: userRows } = await pool.query(
    "SELECT active_project_id FROM telegram_users WHERE chat_id = $1",
    [chatId],
  );

  let projectId = userRows[0]?.active_project_id;

  if (!projectId) {
    // Auto-select if only one project
    const { rows: projRows } = await pool.query("SELECT id FROM projects LIMIT 2");
    if (projRows.length === 1) {
      projectId = projRows[0].id;
      await pool.query(
        `INSERT INTO telegram_users (chat_id, active_project_id)
         VALUES ($1, $2)
         ON CONFLICT (chat_id) DO UPDATE SET active_project_id = $2, updated_at = now()`,
        [chatId, projectId],
      );
    } else if (projRows.length === 0) {
      await sendTelegramMessage(chatId, "Нет проектов. Создай через Dashboard.");
      return;
    } else {
      await sendTelegramMessage(chatId, "Выбери проект: /projects");
      return;
    }
  }

  // Store message in conversation
  const { rows: convRows } = await pool.query(
    "SELECT id FROM conversations WHERE project_id = $1",
    [projectId],
  );

  if (convRows.length) {
    await pool.query(
      `INSERT INTO messages (conversation_id, from_role, source, text, metadata)
       VALUES ($1, 'user', 'telegram', $2, $3)`,
      [convRows[0].id, text, JSON.stringify({ chatId, messageId: message.message_id })],
    );
  }

  // Dispatch Tech Lead
  const config = loadConfig();
  background(dispatchTechLead(projectId, text, config), "telegram:dispatch", projectId);
}

async function handleCommand(chatId: string, text: string): Promise<void> {
  const pool = getPool();
  const [cmd, ...args] = text.split(" ");

  switch (cmd) {
    case "/projects": {
      const { rows } = await pool.query("SELECT id, name, slug FROM projects ORDER BY name");
      if (!rows.length) {
        await sendTelegramMessage(chatId, "Нет проектов.");
        return;
      }

      const { rows: userRows } = await pool.query(
        "SELECT active_project_id FROM telegram_users WHERE chat_id = $1",
        [chatId],
      );
      const activeId = userRows[0]?.active_project_id;

      const list = rows.map((p) => {
        const mark = p.id === activeId ? " ✓" : "";
        return `• ${p.name} (${p.slug})${mark}`;
      }).join("\n");

      await sendTelegramMessage(chatId, `Проекты:\n${list}\n\n/switch <slug>`);
      break;
    }

    case "/switch": {
      const slug = args[0];
      if (!slug) {
        await sendTelegramMessage(chatId, "/switch <slug>");
        return;
      }
      const { rows } = await pool.query("SELECT id, name FROM projects WHERE slug = $1", [slug]);
      if (!rows.length) {
        await sendTelegramMessage(chatId, `Проект "${slug}" не найден`);
        return;
      }
      await pool.query(
        `INSERT INTO telegram_users (chat_id, active_project_id)
         VALUES ($1, $2)
         ON CONFLICT (chat_id) DO UPDATE SET active_project_id = $2, updated_at = now()`,
        [chatId, rows[0].id],
      );
      await sendTelegramMessage(chatId, `Активный проект: ${rows[0].name}`);
      break;
    }

    case "/start": {
      await sendTelegramMessage(chatId, "AI Orchestra Bot\n\n/projects — список проектов\n/switch <slug> — сменить проект\n\nПросто напиши — сообщение уйдёт Tech Lead.");
      break;
    }

    default:
      await sendTelegramMessage(chatId, "Неизвестная команда. /start");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
