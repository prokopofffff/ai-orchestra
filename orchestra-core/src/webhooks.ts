import { Router } from "express";
import { getPool } from "./db.js";
import { addSystemMessage } from "./conversation-api.js";
import { dispatchTechLead } from "./tech-lead-dispatcher.js";
import { loadConfig } from "./config.js";
import { background } from "./error-handler.js";

export const webhookRouter: Router = Router();

// ─── Telegram Webhook ───

webhookRouter.post("/telegram/webhook", async (req, res, next) => {
  try {
    const update = req.body;

    // Extract message
    const message = update.message;
    if (!message?.text) return res.json({ ok: true });

    const chatId = String(message.chat.id);
    const text = message.text as string;
    const pool = getPool();

    // Handle commands
    if (text.startsWith("/")) {
      await handleTelegramCommand(chatId, text);
      return res.json({ ok: true });
    }

    // Get active project for this chat
    const { rows: userRows } = await pool.query(
      "SELECT active_project_id FROM telegram_users WHERE chat_id = $1",
      [chatId],
    );

    let projectId = userRows[0]?.active_project_id;

    if (!projectId) {
      // Auto-select if only one project exists
      const { rows: projRows } = await pool.query("SELECT id FROM projects LIMIT 2");
      if (projRows.length === 1) {
        projectId = projRows[0].id;
        await pool.query(
          `INSERT INTO telegram_users (chat_id, active_project_id)
           VALUES ($1, $2)
           ON CONFLICT (chat_id) DO UPDATE SET active_project_id = $2, updated_at = now()`,
          [chatId, projectId],
        );
      } else {
        // Need to select project
        const { sendTelegramMessage } = await import("./notify.js");
        await sendTelegramMessage(chatId, "Выбери проект: /projects");
        return res.json({ ok: true });
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
    background(dispatchTechLead(projectId, text, config), "webhook:dispatch", projectId);

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ─── Telegram Commands ───

async function handleTelegramCommand(chatId: string, text: string): Promise<void> {
  const { sendTelegramMessage } = await import("./notify.js");
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
        const active = p.id === activeId ? " ✓" : "";
        return `• ${p.name} (\`${p.slug}\`)${active}`;
      }).join("\n");

      await sendTelegramMessage(chatId, `Проекты:\n${list}\n\nИспользуй /switch <slug> для переключения`);
      break;
    }

    case "/switch": {
      const slug = args[0];
      if (!slug) {
        await sendTelegramMessage(chatId, "Использование: /switch <slug>");
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
      await sendTelegramMessage(chatId, "AI Orchestra Bot\n\n/projects — список проектов\n/switch <slug> — переключить проект\n\nПросто напиши сообщение — оно уйдёт Tech Lead.");
      break;
    }

    default: {
      await sendTelegramMessage(chatId, "Неизвестная команда. /start для справки.");
    }
  }
}

// ─── GitHub Webhook ───

webhookRouter.post("/git/webhook", async (req, res, next) => {
  try {
    const event = req.headers["x-github-event"] as string;
    const payload = req.body;

    // Find project by repo URL
    const repoUrl = payload.repository?.html_url;
    if (!repoUrl) return res.json({ ok: true });

    const { rows: projRows } = await getPool().query(
      "SELECT id FROM projects WHERE repo_url = $1",
      [repoUrl],
    );
    if (!projRows.length) return res.json({ ok: true });

    const projectId = projRows[0].id;

    switch (event) {
      case "pull_request": {
        const action = payload.action;
        const pr = payload.pull_request;
        if (action === "opened") {
          await addSystemMessage(projectId, `PR opened: ${pr.title}\n${pr.html_url}`);
        } else if (action === "closed" && pr.merged) {
          await addSystemMessage(projectId, `PR merged: ${pr.title}`);
        }
        break;
      }
      case "push": {
        const branch = payload.ref?.replace("refs/heads/", "");
        const commits = payload.commits?.length ?? 0;
        await addSystemMessage(projectId, `Push to ${branch}: ${commits} commit(s)`);
        break;
      }
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});
