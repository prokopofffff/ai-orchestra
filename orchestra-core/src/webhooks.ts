import { Router } from "express";
import { getPool } from "./db";
import { addSystemMessage } from "./conversation-api";
import { handleTelegramMessage, handleTelegramCommand } from "./telegram-handler";
import { parseGitHubWebhook, parseGitLabWebhook, type WebhookEvent } from "./providers";
import { log } from "./obs";

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

// ─── Git provider webhooks ───
//
// `/api/git/webhook`           — auto-detects provider from request headers
// `/api/git/webhook/github`    — explicit GitHub intake
// `/api/git/webhook/gitlab`    — explicit GitLab intake
//
// Explicit routes make it easier to configure per-project if you host both.
// The generic one stays for back-compat with existing GitHub setups.

type Parser = (
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
) => WebhookEvent;

function detectProvider(headers: Record<string, string | string[] | undefined>): Parser | null {
  if (headers["x-github-event"]) return parseGitHubWebhook;
  if (headers["x-gitlab-event"]) return parseGitLabWebhook;
  return null;
}

async function handleWebhook(event: WebhookEvent): Promise<void> {
  if (event.kind === "ignored") return;

  const { rows: projRows } = await getPool().query(
    "SELECT id FROM projects WHERE repo_url = $1",
    [event.repoUrl],
  );
  if (!projRows.length) return;
  const projectId = projRows[0].id as string;

  switch (event.kind) {
    case "pr_opened":
      await addSystemMessage(projectId, `PR opened: ${event.prTitle}\n${event.prUrl}`);
      return;
    case "pr_merged":
      await addSystemMessage(projectId, `PR merged: ${event.prTitle}`);
      return;
    case "pr_closed":
      await addSystemMessage(projectId, `PR closed: ${event.prTitle}`);
      return;
    case "push":
      await addSystemMessage(projectId, `Push to ${event.branch}: ${event.commits} commit(s)`);
      return;
  }
}

webhookRouter.post("/git/webhook", async (req, res, next) => {
  try {
    const parser = detectProvider(req.headers);
    if (!parser) {
      log.warn({ headers: Object.keys(req.headers) }, "webhook: unknown provider headers");
      return res.json({ ok: true, kind: "unknown" });
    }
    const event = parser(req.headers, req.body);
    await handleWebhook(event);
    res.json({ ok: true, kind: event.kind });
  } catch (e) { next(e); }
});

webhookRouter.post("/git/webhook/github", async (req, res, next) => {
  try {
    const event = parseGitHubWebhook(req.headers, req.body);
    await handleWebhook(event);
    res.json({ ok: true, kind: event.kind });
  } catch (e) { next(e); }
});

webhookRouter.post("/git/webhook/gitlab", async (req, res, next) => {
  try {
    const event = parseGitLabWebhook(req.headers, req.body);
    await handleWebhook(event);
    res.json({ ok: true, kind: event.kind });
  } catch (e) { next(e); }
});
