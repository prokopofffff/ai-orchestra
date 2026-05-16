import type { FastifyPluginAsync } from "fastify";
import { getPool } from "./db";
import { addSystemMessage } from "./conversation-api";
import { parseGitHubWebhook, parseGitLabWebhook, type WebhookEvent } from "./providers";
import { log } from "./obs";

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

export const webhookPlugin: FastifyPluginAsync = async (app) => {
  // Telegram webhook endpoint was removed in the per-project rewrite —
  // the polling manager owns Telegram now, and webhooks would need to
  // be registered per-project (one bot token → one URL) which we don't
  // have a self-hosted URL for. Polling works the same end-to-end.

  // ─── Git provider webhooks ───

  app.post("/git/webhook", async (request) => {
    const parser = detectProvider(request.headers);
    if (!parser) {
      log.warn({ headers: Object.keys(request.headers) }, "webhook: unknown provider headers");
      return { ok: true, kind: "unknown" };
    }
    const event = parser(request.headers, request.body);
    await handleWebhook(event);
    return { ok: true, kind: event.kind };
  });

  app.post("/git/webhook/github", async (request) => {
    const event = parseGitHubWebhook(request.headers, request.body);
    await handleWebhook(event);
    return { ok: true, kind: event.kind };
  });

  app.post("/git/webhook/gitlab", async (request) => {
    const event = parseGitLabWebhook(request.headers, request.body);
    await handleWebhook(event);
    return { ok: true, kind: event.kind };
  });
};
