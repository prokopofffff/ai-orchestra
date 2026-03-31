import { Router, Request, Response } from "express";
import { z } from "zod";
import { OrchestraConfig } from "./config.js";
import { AgentSpawner } from "./agent-spawner.js";
import { notifyUser } from "./notify.js";

// --- Telegram Webhook ---

const TelegramUpdateSchema = z.object({
  message: z.object({
    chat: z.object({ id: z.number() }),
    from: z.object({
      username: z.string().optional(),
      first_name: z.string().optional(),
    }).optional(),
    text: z.string().optional(),
    message_id: z.number(),
    date: z.number(),
  }).optional(),
  edited_message: z.object({
    chat: z.object({ id: z.number() }),
    from: z.object({
      username: z.string().optional(),
      first_name: z.string().optional(),
    }).optional(),
    text: z.string().optional(),
    message_id: z.number(),
    date: z.number(),
  }).optional(),
}).passthrough();

// --- Git Webhook ---

const GitEventSchema = z.object({
  provider: z.enum(["github", "gitlab", "unknown"]),
  type: z.enum(["pull_request", "pr_review", "push", "unknown"]),
  action: z.string(),
  prNumber: z.number().nullable(),
  prTitle: z.string(),
  prUrl: z.string(),
  branch: z.string(),
  repo: z.string(),
  author: z.string(),
});
type GitEvent = z.infer<typeof GitEventSchema>;

export function createWebhookRouter(
  config: OrchestraConfig,
  spawner: AgentSpawner
): Router {
  const router = Router();

  // POST /api/telegram/webhook — receives Telegram Bot API updates
  router.post("/telegram/webhook", async (req: Request, res: Response) => {
    try {
      const parsed = TelegramUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.json({ ok: true });
        return;
      }

      const msg = parsed.data.message || parsed.data.edited_message;
      if (!msg || !msg.text) {
        res.json({ ok: true });
        return;
      }

      const chatId = String(msg.chat.id);
      const username = msg.from?.username || msg.from?.first_name || "user";
      const text = msg.text;

      // Verify chat_id matches configured user
      if (config.telegram.chatId && chatId !== config.telegram.chatId) {
        console.warn(`[TELEGRAM] Ignored message from unknown chat_id: ${chatId}`);
        res.json({ ok: true });
        return;
      }

      console.log(`[TELEGRAM] Message from ${username}: ${text.substring(0, 50)}...`);

      // Dispatch to Tech Lead
      const result = await spawner.spawn({
        role: "tech-lead",
        projectId: "default",
        prompt: `Сообщение от пользователя ${username} (chat_id: ${chatId}) через Telegram:\n\n${text}\n\nОтветь пользователю через notify_user().`,
      });

      res.json({ ok: true, dispatched: true, sessionId: result.sessionId });
    } catch (err) {
      console.error("[TELEGRAM] Webhook error:", err);
      res.json({ ok: true }); // Always return 200 to Telegram
    }
  });

  // POST /api/git/webhook — receives GitHub/GitLab webhook events
  router.post("/git/webhook", async (req: Request, res: Response) => {
    try {
      const headers = req.headers;
      const body = req.body;

      const event = normalizeGitEvent(headers, body);

      if (event.type === "unknown") {
        res.json({ status: "ignored", event_type: "unknown" });
        return;
      }

      console.log(`[GIT] ${event.provider} ${event.type}: ${event.action} on ${event.repo}`);

      // Route based on event type
      if (event.type === "pull_request" && event.action === "opened") {
        // PR opened → signal QA
        await spawner.spawn({
          role: "qa",
          projectId: extractProjectId(event.repo),
          prompt: `Новый PR: #${event.prNumber} "${event.prTitle}"\nURL: ${event.prUrl}\nBranch: ${event.branch}\nRepo: ${event.repo}\n\nНапиши тесты для этого PR.`,
        });

        await notifyUser(config,
          `[${event.provider}] New PR #${event.prNumber}: ${event.prTitle}`
        );
      } else if (event.type === "pr_review") {
        // PR review → notify Tech Lead
        await spawner.spawn({
          role: "tech-lead",
          projectId: extractProjectId(event.repo),
          prompt: `PR review update: #${event.prNumber} — ${event.action} by ${event.author}\nRepo: ${event.repo}`,
        });
      } else if (event.type === "push") {
        // Push — just notify
        await notifyUser(config,
          `[${event.provider}] Push to ${event.branch} in ${event.repo} by ${event.author}`
        );
      }

      res.json({ status: "processed", event_type: event.type, action: event.action });
    } catch (err) {
      console.error("[GIT] Webhook error:", err);
      res.status(500).json({ error: "Failed to process git webhook" });
    }
  });

  return router;
}

function normalizeGitEvent(
  headers: Record<string, unknown>,
  body: Record<string, unknown>
): GitEvent {
  const event: GitEvent = {
    provider: "unknown",
    type: "unknown",
    action: "",
    prNumber: null,
    prTitle: "",
    prUrl: "",
    branch: "",
    repo: "",
    author: "",
  };

  // GitHub
  const ghEvent = headers["x-github-event"] as string | undefined;
  if (ghEvent) {
    event.provider = "github";
    event.repo = (body.repository as Record<string, unknown>)?.full_name as string || "";

    if (ghEvent === "pull_request") {
      const pr = body.pull_request as Record<string, unknown>;
      event.type = "pull_request";
      event.action = body.action as string;
      event.prNumber = pr?.number as number;
      event.prTitle = (pr?.title as string) || "";
      event.prUrl = (pr?.html_url as string) || "";
      event.branch = ((pr?.head as Record<string, unknown>)?.ref as string) || "";
      event.author = ((pr?.user as Record<string, unknown>)?.login as string) || "";
    } else if (ghEvent === "pull_request_review") {
      const review = body.review as Record<string, unknown>;
      const pr = body.pull_request as Record<string, unknown>;
      event.type = "pr_review";
      event.action = (review?.state as string) || "";
      event.prNumber = pr?.number as number;
      event.prTitle = (pr?.title as string) || "";
      event.branch = ((pr?.head as Record<string, unknown>)?.ref as string) || "";
      event.author = ((review?.user as Record<string, unknown>)?.login as string) || "";
    } else if (ghEvent === "push") {
      event.type = "push";
      event.branch = ((body.ref as string) || "").replace("refs/heads/", "");
      event.author = ((body.pusher as Record<string, unknown>)?.name as string) || "";
    }
  }

  // GitLab
  const glEvent = headers["x-gitlab-event"] as string | undefined;
  if (glEvent) {
    event.provider = "gitlab";
    event.repo = ((body.project as Record<string, unknown>)?.path_with_namespace as string) || "";

    if (glEvent === "Merge Request Hook") {
      const attrs = body.object_attributes as Record<string, unknown>;
      event.type = "pull_request";
      event.action = (attrs?.action as string) || "";
      event.prNumber = attrs?.iid as number;
      event.prTitle = (attrs?.title as string) || "";
      event.prUrl = (attrs?.url as string) || "";
      event.branch = (attrs?.source_branch as string) || "";
      event.author = ((body.user as Record<string, unknown>)?.username as string) || "";
    } else if (glEvent === "Push Hook") {
      event.type = "push";
      event.branch = ((body.ref as string) || "").replace("refs/heads/", "");
      event.author = (body.user_username as string) || "";
    }
  }

  return event;
}

function extractProjectId(repo: string): string {
  // "org/repo-name" → "repo-name"
  return repo.split("/").pop() || "default";
}
