import { eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { projects } from "./db/schema";
import { handleTelegramMessage, handleTelegramCommand } from "./telegram-handler";
import { log } from "./obs";

/**
 * Per-project Telegram polling. Telegram's getUpdates long-poll is
 * exclusive — only one listener can drain a bot's update queue at a
 * time. So we run one loop per project that has a `botToken` set in
 * settings.telegram, scoped to that project (its chat, its updates).
 *
 * Lifecycle: reconcile() reads all projects' configs and starts /
 * stops loops to match. Called on boot and after each project
 * create/update (best-effort via timer, no need for explicit triggers).
 */
const active = new Map<string, { token: string; controller: AbortController }>();
let reconcileTimer: NodeJS.Timeout | null = null;

type ProjectTelegramRow = { id: string; token: string };

async function listProjectsWithTelegram(): Promise<ProjectTelegramRow[]> {
  const rows = await getDb()
    .select({
      id: projects.id,
      token: sql<string>`${projects.settings} -> 'telegram' ->> 'botToken'`,
    })
    .from(projects)
    .where(sql`${projects.settings} -> 'telegram' ->> 'botToken' IS NOT NULL`);
  return rows.filter((r) => !!r.token);
}

async function reconcile(): Promise<void> {
  const raw = await listProjectsWithTelegram();
  // Multi-tenant safety: a Telegram bot's getUpdates queue is exclusive — two
  // projects pointed at the same bot token would drain each other's updates,
  // delivering tenant A's messages into tenant B's project conversation. The
  // partial unique index + task-api pre-save check (findTelegramConflict) are
  // supposed to prevent this, but races / manual DB edits / migrations could
  // slip a duplicate through. Detect and refuse: keep only the first project
  // for each token and log the rest so the operator can clean up.
  const byToken = new Map<string, ProjectTelegramRow>();
  const duplicates: ProjectTelegramRow[] = [];
  for (const r of raw) {
    if (byToken.has(r.token)) {
      duplicates.push(r);
      continue;
    }
    byToken.set(r.token, r);
  }
  if (duplicates.length > 0) {
    log.error(
      { duplicates: duplicates.map((d) => d.id), kept: [...byToken.values()].map((k) => k.id) },
      "telegram poll: duplicate bot tokens across projects — skipping later occurrences. " +
      "Cross-tenant message leak risk. Run `SELECT id, settings->'telegram'->>'botToken' FROM projects` to find them.",
    );
  }
  const wanted = [...byToken.values()];
  const wantedIds = new Set(wanted.map((w) => w.id));

  // Stop loops whose project lost its token (or was deleted).
  for (const [projectId, slot] of active.entries()) {
    if (!wantedIds.has(projectId)) {
      slot.controller.abort();
      active.delete(projectId);
      log.info({ projectId }, "telegram poll: stopped");
    }
  }

  // Start loops for projects newly equipped with a token, or restart if
  // the token changed.
  for (const w of wanted) {
    const existing = active.get(w.id);
    if (existing && existing.token === w.token) continue;
    if (existing) {
      existing.controller.abort();
      active.delete(w.id);
    }
    startProjectPoll(w.id, w.token);
  }
}

function startProjectPoll(projectId: string, token: string): void {
  const controller = new AbortController();
  active.set(projectId, { token, controller });
  log.info({ projectId }, "telegram poll: started");
  void runLoop(projectId, token, controller.signal);
}

async function runLoop(projectId: string, token: string, abort: AbortSignal): Promise<void> {
  let offset = 0;
  while (!abort.aborted) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30`,
        { signal: anyAbort([abort, AbortSignal.timeout(35000)]) },
      );
      if (!res.ok) {
        // 401 / 404 = token invalid; stop the loop until reconcile fixes it.
        if (res.status === 401 || res.status === 404) {
          log.warn({ projectId, status: res.status }, "telegram poll: token rejected, stopping");
          active.delete(projectId);
          return;
        }
        log.warn({ projectId, status: res.status }, "telegram poll: non-OK");
        await sleep(5000);
        continue;
      }
      const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };
      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          await handleUpdate(projectId, token, update);
        }
      }
    } catch (err) {
      if (abort.aborted) return;
      log.error({ err, projectId }, "telegram poll error");
      await sleep(5000);
    }
  }
}

/** Combine multiple AbortSignals into one. */
function anyAbort(signals: AbortSignal[]): AbortSignal {
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) { c.abort(); return c.signal; }
    s.addEventListener("abort", () => c.abort(), { once: true });
  }
  return c.signal;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
}

async function handleUpdate(projectId: string, token: string, update: TelegramUpdate): Promise<void> {
  const m = update.message;
  if (!m?.text) return;
  const chatId = String(m.chat.id);
  if (m.text.startsWith("/")) {
    await handleTelegramCommand(projectId, token, chatId, m.text);
  } else {
    await handleTelegramMessage(projectId, token, chatId, m.text, m.message_id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Boot up: reconcile once, then keep reconciling every 30s. */
export async function startTelegramManager(): Promise<void> {
  await reconcile();
  reconcileTimer = setInterval(() => {
    reconcile().catch((err) => log.error({ err }, "telegram reconcile failed"));
  }, 30_000);
}

export function stopTelegramManager(): void {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  for (const [, slot] of active) slot.controller.abort();
  active.clear();
}

/** Force-reconcile from callers (project save handlers); idempotent. */
export async function reconcileTelegramNow(): Promise<void> {
  await reconcile();
}

/**
 * Bind a chat to a project (called from the handler on first /start).
 * Stores chatId in settings.telegram so notify() knows where to send.
 */
export async function bindChatToProject(projectId: string, chatId: string): Promise<void> {
  await getDb()
    .update(projects)
    .set({
      settings: sql`jsonb_set(${projects.settings}, '{telegram,chatId}', to_jsonb(${chatId}::text), true)`,
    })
    .where(eq(projects.id, projectId));
}
