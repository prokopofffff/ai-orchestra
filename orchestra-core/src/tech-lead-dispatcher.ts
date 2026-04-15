import { query, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type Config, getModelForRole } from "./config";
import {
  createSession,
  updateSession,
  getActiveSessionForRole,
} from "./session-manager";
import { buildBootstrapContext, formatBootstrapPrompt } from "./session-context";
import { log } from "./obs";
import { generateMcpConfig } from "./mcp-config-generator";
import { getPool } from "./db";
import { notify } from "./notification-hub";
import { appendLog } from "./logger";
import { ensureRepo, ensureTempDir } from "./repo-manager";
import { extractText } from "./agents/sdk-runner";
import { loadSystemPrompt, assemblePrompt } from "./agents/prompt";

// Track in-flight Tech Lead conversations (per-project) so we can interrupt.
const techLeadQueries = new Map<string, Query>();

export async function dispatchTechLead(
  projectId: string,
  userMessage: string,
  config: Config,
): Promise<{ action: "already_running" | "spawned" | "error"; sessionId?: string; error?: string }> {
  try {
    // Already running → enqueue the message as a signal and return.
    const existing = await getActiveSessionForRole(projectId, "tech-lead");
    if (existing) {
      await getPool().query(
        `INSERT INTO signals (project_id, from_role, to_role, action, payload)
         VALUES ($1, 'user', 'tech-lead', 'notify', $2)`,
        [projectId, JSON.stringify({ message: userMessage })],
      );
      return { action: "already_running", sessionId: existing.id };
    }

    const pool = getPool();
    const { rows: projRows } = await pool.query(
      "SELECT slug, repo_url, settings FROM projects WHERE id = $1",
      [projectId],
    );
    if (!projRows.length) return { action: "error", error: "Project not found" };

    const { slug, repo_url: repoUrl, settings } = projRows[0];
    const model = getModelForRole(config, "tech-lead", settings as Record<string, unknown>);

    const workDir = repoUrl ? await ensureRepo(repoUrl, slug) : ensureTempDir(slug);

    const bootstrap = formatBootstrapPrompt(await buildBootstrapContext(projectId, "tech-lead"));
    const conversationHistory = await getConversationHistory(projectId);

    const fullPrompt = assemblePrompt({
      systemPrompt: loadSystemPrompt("tech-lead"),
      bootstrap,
      tail: [
        conversationHistory,
        "\n## Latest User Message\n",
        userMessage,
        "\n\nRespond to the user's latest message above. You have the full conversation history — do NOT ask the user to repeat themselves. Continue where the conversation left off.",
      ].join("\n"),
    });

    const session = await createSession({
      projectId,
      role: "tech-lead",
      model,
      worktreePath: workDir,
    });

    const { mcpServers } = generateMcpConfig("tech-lead", config, projectId);

    // Run the conversation in the background — the HTTP request that triggered
    // this returns immediately; the tech-lead's reply arrives via notify().
    void runTechLead({
      projectId, sessionId: session.id, model, workDir, fullPrompt, mcpServers,
    });

    return { action: "spawned", sessionId: session.id };
  } catch (e) {
    log.error({ err: e, projectId }, "tech-lead dispatch failed");
    return { action: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

async function runTechLead(p: {
  projectId: string;
  sessionId: string;
  model: string;
  workDir: string;
  fullPrompt: string;
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}): Promise<void> {
  appendLog(p.projectId, p.sessionId, "tech-lead", "system", `tech-lead run: model=${p.model}`);

  const stream = query({
    prompt: p.fullPrompt,
    options: {
      model: p.model,
      cwd: p.workDir,
      permissionMode: "bypassPermissions",
      mcpServers: Object.fromEntries(
        Object.entries(p.mcpServers).map(([name, s]) => [
          name,
          { type: "stdio" as const, command: s.command, args: s.args, env: s.env },
        ]),
      ),
    },
  });

  techLeadQueries.set(p.projectId, stream);
  let reply = "";

  try {
    for await (const message of stream) {
      const text = textFromMessage(message);
      if (text) {
        reply += (reply ? "\n" : "") + text;
        appendLog(p.projectId, p.sessionId, "tech-lead", "stdout", text);
      }
    }
    await updateSession(p.sessionId, { status: "terminated", finishedAt: new Date() });
  } catch (err) {
    await updateSession(p.sessionId, { status: "crashed", finishedAt: new Date() });
    log.error({ err, projectId: p.projectId, sessionId: p.sessionId }, "tech-lead run failed");
  } finally {
    techLeadQueries.delete(p.projectId);
  }

  const trimmed = reply.trim();
  if (trimmed) {
    await notify({
      projectId: p.projectId,
      text: trimmed,
      priority: "high",
      fromRole: "tech-lead",
    }).catch((err) => log.error({ err, projectId: p.projectId }, "tech-lead notify failed"));
  }
}

function textFromMessage(m: SDKMessage): string {
  if (m.type === "assistant") return extractText(m.message.content);
  return "";
}

/** Cancel an in-flight tech-lead conversation if one exists. */
export async function interruptTechLead(projectId: string): Promise<boolean> {
  const q = techLeadQueries.get(projectId);
  if (!q) return false;
  await q.interrupt();
  techLeadQueries.delete(projectId);
  return true;
}

async function getConversationHistory(projectId: string): Promise<string> {
  const pool = getPool();

  const { rows: convRows } = await pool.query(
    "SELECT id FROM conversations WHERE project_id = $1",
    [projectId],
  );
  if (!convRows.length) return "";

  const { rows } = await pool.query(
    `SELECT from_role, text FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC LIMIT 30`,
    [convRows[0].id],
  );

  if (!rows.length) return "";

  const messages = rows.reverse();
  const lines = ["\n## Conversation History\n"];
  for (const msg of messages) {
    const role = msg.from_role as string;
    const label = role === "user" ? "User" : role === "tech-lead" ? "You (Tech Lead)" : "System";
    lines.push(`**${label}:**`);
    lines.push(msg.text as string);
    lines.push("");
  }

  return lines.join("\n");
}
