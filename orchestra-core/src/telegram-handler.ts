import { eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { projects, conversations, messages } from "./db/schema";
import { sendTelegramMessage } from "./notify";
import { dispatchTechLead } from "./tech-lead-dispatcher";
import { loadConfig } from "./config";
import { background } from "./error-handler";
import { bindChatToProject } from "./telegram-manager";

/**
 * Project is now implicit in the bot — each project has its own bot
 * token, the polling manager invokes us with both. We bind the first
 * chat that talks to the bot as the project's chatId (so notify() knows
 * where to push), and only respond to that chat thereafter.
 */

interface BoundChat {
  current: string | undefined;
}

async function getProjectChat(projectId: string): Promise<BoundChat> {
  const [row] = await getDb()
    .select({ chatId: sql<string | null>`${projects.settings} -> 'telegram' ->> 'chatId'` })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return { current: row?.chatId ?? undefined };
}

/**
 * Handle an incoming text message: store, dispatch TL, but only if the
 * sender is the project's bound chat (or if no chat is bound yet — in
 * which case any incoming message must be a /start, see handleCommand).
 */
export async function handleTelegramMessage(
  projectId: string,
  token: string,
  chatId: string,
  text: string,
  messageId?: number,
): Promise<void> {
  const { current } = await getProjectChat(projectId);
  if (!current) {
    await sendTelegramMessage(token, chatId, "Send /start to bind this chat to the project first.");
    return;
  }
  if (current !== chatId) {
    // Different chat than the bound one — ignore to keep noise out of
    // the project's conversation. Could surface this as an audit row
    // later; for now silent + a polite nudge.
    await sendTelegramMessage(token, chatId, "This bot is bound to a different chat.");
    return;
  }

  const [conv] = await getDb()
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.projectId, projectId))
    .limit(1);
  if (conv) {
    await getDb().insert(messages).values({
      conversationId: conv.id,
      fromRole: "user",
      source: "telegram",
      text,
      metadata: { chatId, messageId },
    });
  }

  const config = loadConfig();
  background(dispatchTechLead(projectId, text, config), "telegram:dispatch", projectId);
}

/**
 * Handle a /command. Only one command matters now (/start) — it binds
 * the chat to the project and confirms. /projects and /switch went away
 * because each project has its own dedicated bot.
 */
export async function handleTelegramCommand(
  projectId: string,
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  const [cmd] = text.split(" ");
  switch (cmd) {
    case "/start": {
      const [proj] = await getDb()
        .select({ name: projects.name })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const projectName = proj?.name ?? "this project";

      const { current } = await getProjectChat(projectId);
      if (current && current !== chatId) {
        await sendTelegramMessage(
          token, chatId,
          `This bot is already bound to a different chat for "${projectName}". A user has to unbind it from the dashboard first.`,
        );
        return;
      }
      if (!current) {
        await bindChatToProject(projectId, chatId);
        await sendTelegramMessage(
          token, chatId,
          `Connected to AI Orchestra · *${projectName}*\n\nJust write — your message goes straight to Tech Lead.`,
        );
        return;
      }
      // Already bound to this same chat — gentle confirmation.
      await sendTelegramMessage(
        token, chatId,
        `Already connected · *${projectName}*. Write away.`,
      );
      break;
    }
    default:
      await sendTelegramMessage(token, chatId, "Unknown command. Try /start.");
  }
}
