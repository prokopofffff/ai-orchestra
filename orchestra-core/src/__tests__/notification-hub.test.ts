import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { waitForDatabase, runMigrations, getPool } from "../db";
import {
  notify,
  notifyTaskStateChange,
  notifyPrReady,
  notifyEscalation,
  notifyAgentEvent,
} from "../notification-hub";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

let projectId: string;

beforeAll(async () => {
  await waitForDatabase(DATABASE_URL);
  await runMigrations(DATABASE_URL);
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM telegram_users");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM conversations");
  await pool.query("DELETE FROM projects WHERE slug = 'notify-test'");

  const { rows } = await pool.query(
    "INSERT INTO projects (name, slug) VALUES ('Notify Test', 'notify-test') RETURNING id",
  );
  projectId = rows[0].id;
  await pool.query("INSERT INTO conversations (project_id) VALUES ($1)", [projectId]);
});

afterEach(() => {
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_BOT_TOKEN;
});

afterAll(async () => {
  await getPool().end();
});

async function getMessages(): Promise<Array<{ fromRole: string; text: string; metadata: Record<string, unknown> }>> {
  const { rows } = await getPool().query(
    `SELECT from_role AS "fromRole", text, metadata
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.project_id = $1
     ORDER BY m.created_at ASC`,
    [projectId],
  );
  return rows;
}

describe("notification-hub — notify", () => {
  it("stores a system message by default", async () => {
    await notify({ projectId, text: "hello", priority: "normal" });
    const msgs = await getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].fromRole).toBe("system");
    expect(msgs[0].text).toBe("hello");
  });

  it("stores a tech-lead message when fromRole='tech-lead'", async () => {
    await notify({ projectId, text: "tl reply", priority: "normal", fromRole: "tech-lead" });
    const msgs = await getMessages();
    expect(msgs[0].fromRole).toBe("tech-lead");
  });

  it("passes metadata through to the stored message", async () => {
    await notify({
      projectId, text: "x", priority: "normal",
      metadata: { event: "test", flag: 42 },
    });
    const msgs = await getMessages();
    expect(msgs[0].metadata).toMatchObject({ event: "test", flag: 42 });
  });

  it("no-ops telegram delivery when no chatId is configured", async () => {
    // No telegram_users row, no TELEGRAM_CHAT_ID env — should complete without error
    await expect(notify({ projectId, text: "x", priority: "normal" })).resolves.toBeUndefined();
  });

  it("tries telegram when a telegram_users row matches the project", async () => {
    await getPool().query(
      `INSERT INTO telegram_users (chat_id, active_project_id) VALUES ($1, $2)`,
      ["12345", projectId],
    );
    // No TELEGRAM_BOT_TOKEN — sendTelegramMessage will early-return false, but
    // notify should still complete and the message should still be stored.
    await notify({ projectId, text: "x", priority: "normal" });
    expect((await getMessages()).length).toBe(1);
  });

  it("falls back to TELEGRAM_CHAT_ID env when no telegram_users row exists", async () => {
    process.env.TELEGRAM_CHAT_ID = "global-chat";
    // Again no bot token — code path exercised, no throw
    await notify({ projectId, text: "x", priority: "normal" });
    expect((await getMessages()).length).toBe(1);
  });
});

describe("notification-hub — convenience wrappers", () => {
  it("notifyTaskStateChange tags event metadata", async () => {
    await notifyTaskStateChange(projectId, "My Task", "in_development", "pr_created");
    const [msg] = await getMessages();
    expect(msg.text).toContain("My Task");
    expect(msg.text).toContain("pr_created");
    expect(msg.metadata).toMatchObject({
      event: "task_state_change",
      oldState: "in_development",
      newState: "pr_created",
    });
    expect(msg.fromRole).toBe("system");
  });

  it("notifyPrReady sends as tech-lead with high priority metadata", async () => {
    await notifyPrReady(projectId, "Feature X", "https://github.com/o/r/pull/1");
    const [msg] = await getMessages();
    expect(msg.fromRole).toBe("tech-lead");
    expect(msg.text).toContain("Feature X");
    expect(msg.text).toContain("https://github.com/o/r/pull/1");
    expect(msg.metadata).toMatchObject({ event: "pr_ready" });
  });

  it("notifyEscalation prefixes with warning + sender role", async () => {
    await notifyEscalation(projectId, "qa", "tests failing");
    const [msg] = await getMessages();
    expect(msg.text).toContain("⚠");
    expect(msg.text).toContain("qa");
    expect(msg.text).toContain("tests failing");
    expect(msg.metadata).toMatchObject({ event: "escalation", fromRole: "qa" });
  });

  it.each(["spawned", "finished", "crashed"] as const)(
    "notifyAgentEvent — %s variant",
    async (event) => {
      await notifyAgentEvent(projectId, "backend", event, "My Task");
      const [msg] = await getMessages();
      expect(msg.text).toContain("backend");
      expect(msg.text).toContain("My Task");
      expect(msg.metadata).toMatchObject({ event: `agent_${event}`, role: "backend" });
    },
  );
});
