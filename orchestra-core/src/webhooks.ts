import { Router } from "express";
import { getPool } from "./db.js";
import { addSystemMessage } from "./conversation-api.js";
import { handleTelegramMessage, handleTelegramCommand } from "./telegram-handler.js";

export const webhookRouter: Router = Router();

// ─── Telegram Webhook ───

webhookRouter.post("/telegram/webhook", async (req, res, next) => {
  try {
    const update = req.body;
    const message = update.message;
    if (!message?.text) return res.json({ ok: true });

    const chatId = String(message.chat.id);
    const text = message.text as string;

    if (text.startsWith("/")) {
      await handleTelegramCommand(chatId, text);
    } else {
      await handleTelegramMessage(chatId, text, message.message_id);
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ─── GitHub Webhook ───

webhookRouter.post("/git/webhook", async (req, res, next) => {
  try {
    const event = req.headers["x-github-event"] as string;
    const payload = req.body;

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
