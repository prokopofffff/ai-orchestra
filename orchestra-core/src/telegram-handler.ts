import { getPool } from "./db.js";
import { sendTelegramMessage } from "./notify.js";
import { dispatchTechLead } from "./tech-lead-dispatcher.js";
import { loadConfig } from "./config.js";
import { background } from "./error-handler.js";

/**
 * Handle an incoming Telegram message (text, not command).
 * Resolves project, stores in conversation, dispatches Tech Lead.
 */
export async function handleTelegramMessage(
  chatId: string,
  text: string,
  messageId?: number,
): Promise<void> {
  const pool = getPool();

  const projectId = await resolveProjectForChat(chatId);
  if (!projectId) return;

  // Store in conversation
  const { rows: convRows } = await pool.query(
    "SELECT id FROM conversations WHERE project_id = $1",
    [projectId],
  );
  if (convRows.length) {
    await pool.query(
      `INSERT INTO messages (conversation_id, from_role, source, text, metadata)
       VALUES ($1, 'user', 'telegram', $2, $3)`,
      [convRows[0].id, text, JSON.stringify({ chatId, messageId })],
    );
  }

  // Dispatch Tech Lead
  const config = loadConfig();
  background(dispatchTechLead(projectId, text, config), "telegram:dispatch", projectId);
}

/**
 * Handle a Telegram command (/start, /projects, /switch).
 */
export async function handleTelegramCommand(chatId: string, text: string): Promise<void> {
  const pool = getPool();
  const [cmd, ...args] = text.split(" ");

  switch (cmd) {
    case "/projects": {
      const { rows } = await pool.query("SELECT id, name, slug FROM projects ORDER BY name");
      if (!rows.length) {
        await sendTelegramMessage(chatId, "Нет проектов. Создай через Dashboard.");
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
      await setActiveProject(chatId, rows[0].id);
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

/**
 * Resolve the active project for a Telegram chat.
 * Auto-selects if only one project exists. Returns null if user must choose.
 */
async function resolveProjectForChat(chatId: string): Promise<string | null> {
  const pool = getPool();

  const { rows: userRows } = await pool.query(
    "SELECT active_project_id FROM telegram_users WHERE chat_id = $1",
    [chatId],
  );

  if (userRows[0]?.active_project_id) return userRows[0].active_project_id;

  // Auto-select if only one project
  const { rows: projRows } = await pool.query("SELECT id FROM projects LIMIT 2");
  if (projRows.length === 1) {
    await setActiveProject(chatId, projRows[0].id);
    return projRows[0].id;
  }

  if (projRows.length === 0) {
    await sendTelegramMessage(chatId, "Нет проектов. Создай через Dashboard.");
  } else {
    await sendTelegramMessage(chatId, "Выбери проект: /projects");
  }
  return null;
}

async function setActiveProject(chatId: string, projectId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO telegram_users (chat_id, active_project_id)
     VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET active_project_id = $2, updated_at = now()`,
    [chatId, projectId],
  );
}
