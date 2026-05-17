import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
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
import { extractText, extractAssistantText, buildCanUseTool } from "./agents/sdk-runner";
import { getAgentConfig } from "./agents/configs";
import { buildAgentDefinitions } from "./agents/role-definitions";
import { providerFor } from "./providers";
import type { ProjectSettings } from "@ai-orchestra/shared";

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
      "SELECT slug, repo_url, local_path, settings FROM projects WHERE id = $1",
      [projectId],
    );
    if (!projRows.length) return { action: "error", error: "Project not found" };

    const { slug, repo_url: repoUrl, local_path: localPath, settings } = projRows[0];
    const model = getModelForRole(config, "tech-lead", settings as Record<string, unknown>);

    // Workspace resolution mirrors agent-spawner — local_path wins, then
    // repo_url (cloned), then a per-project temp dir. Without this branch,
    // a project that the user created via the folder picker (no repo URL)
    // would land in /Users/.../orchestra-workspaces/project-<slug>/workspace
    // as a sibling of every other project's temp dir, and TL would walk
    // up `..` to read code from unrelated projects.
    let workDir: string;
    if (localPath) {
      workDir = localPath as string;
    } else if (repoUrl) {
      const provider = providerFor(repoUrl, settings as ProjectSettings | null);
      workDir = await ensureRepo(provider.tokenizeCloneUrl(), slug);
    } else {
      workDir = ensureTempDir(slug);
    }

    const bootstrap = formatBootstrapPrompt(await buildBootstrapContext(projectId, "tech-lead"));
    const conversationHistory = await getConversationHistory(projectId);

    // Dynamic user turn = bootstrap context + conversation history + new
    // user message. Role identity/rules come from the SDK agent definition
    // selected below via `agent: "tech-lead"`.
    const userTurn = [
      bootstrap,
      conversationHistory,
      "\n## Latest User Message\n",
      userMessage,
      "\n\nRespond to the user's latest message above. You have the full conversation history — do NOT ask the user to repeat themselves. Continue where the conversation left off.",
    ].join("\n");

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
      projectId, sessionId: session.id, model, workDir,
      userTurn, mcpServers, pencilEnabled: config.pencilEnabled,
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
  userTurn: string;
  pencilEnabled?: boolean;
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}): Promise<void> {
  appendLog(p.projectId, p.sessionId, "tech-lead", "system", `tech-lead run: model=${p.model}`);

  const agents = buildAgentDefinitions({ pencilEnabled: p.pencilEnabled });
  const tlCfg = getAgentConfig("tech-lead");
  const stream = query({
    prompt: p.userTurn,
    options: {
      agent: "tech-lead",
      agents,
      model: p.model,
      cwd: p.workDir,
      permissionMode: "default",
      // Options-level disallowedTools STRIPS these names from the model's
      // available tool set — the LLM never sees "Bash" or "Write" as
      // callable. Per the SDK docs this is stronger than the agent-level
      // AgentDefinition.disallowedTools (which proved unreliable for the
      // main-thread agent — model still emitted [tool:Bash] calls).
      // canUseTool then catches anything that somehow slips through and
      // enforces the path-confinement sandbox.
      disallowedTools: tlCfg.toolsDeny ?? [],
      canUseTool: buildCanUseTool(tlCfg.scope.denied, tlCfg.toolsDeny ?? [], p.workDir),
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
  // Mid-stream code-block guard. Tracks whether we're inside a fenced
  // block and how many body lines have streamed since the opening fence.
  // Crossing MAX_CODE_BLOCK_LINES counts as TL trying to implement the
  // feature in chat (the failure mode we keep seeing); we abort the run
  // immediately and replace the partial reply with a system note.
  const guard = { open: false, lines: 0 };
  let violation: string | null = null;

  try {
    for await (const message of stream) {
      if (message.type !== "assistant") continue;
      const logText = extractText(message.message.content);
      if (logText) appendLog(p.projectId, p.sessionId, "tech-lead", "stdout", logText);
      const chatText = extractAssistantText(message.message.content);
      if (chatText) {
        reply += (reply ? "\n" : "") + chatText;
        if (!violation) {
          violation = scanForCodeBlockViolation(chatText, guard);
          if (violation) {
            appendLog(p.projectId, p.sessionId, "tech-lead", "error",
              `RUN ABORTED: ${violation}. Chat reply was pasting implementation instead of creating tasks.`);
            await stream.interrupt().catch(() => { /* already over */ });
            break;
          }
        }
      }
    }
    await updateSession(p.sessionId, {
      status: violation ? "crashed" : "terminated",
      finishedAt: new Date(),
    });
  } catch (err) {
    await updateSession(p.sessionId, { status: "crashed", finishedAt: new Date() });
    log.error({ err, projectId: p.projectId, sessionId: p.sessionId }, "tech-lead run failed");
  } finally {
    techLeadQueries.delete(p.projectId);
  }

  if (violation) {
    // Don't post TL's partial implementation to the user. Replace with a
    // system message describing what happened — gives the user a chance
    // to re-ask in a way that nudges TL toward tasks, and the next TL
    // turn will see this in its conversation history as feedback.
    await notify({
      projectId: p.projectId,
      text:
        "⚠️ Tech Lead started writing code in chat (forbidden) — the run was aborted. " +
        "Tech Lead's job is to create tasks via `task_create` and delegate to the frontend / backend / designer agents, not to paste implementations. " +
        "Try re-asking with: \"create tasks for the dev team — don't write code yourself.\"",
      priority: "high",
      fromRole: "system",
    }).catch((err) => log.error({ err, projectId: p.projectId }, "violation notify failed"));
    return;
  }

  // Defense in depth: even if no single block crossed the streaming
  // threshold, sanitize the assembled reply once more. A leak-through
  // (e.g. ten 8-line blocks) still violates the spirit of the rule.
  const sanitized = stripLongCodeBlocks(reply);
  const trimmed = sanitized.trim();
  if (trimmed) {
    await notify({
      projectId: p.projectId,
      text: trimmed,
      priority: "high",
      fromRole: "tech-lead",
    }).catch((err) => log.error({ err, projectId: p.projectId }, "tech-lead notify failed"));
  }
}

const MAX_CODE_BLOCK_LINES = 10;

/**
 * Walk a chunk of newly-streamed text and update the multi-call guard
 * tracking whether the model is currently inside a fenced code block
 * and how many body lines have streamed. Returns a violation reason if
 * the current block crosses MAX_CODE_BLOCK_LINES, null otherwise.
 *
 * Exported for tests.
 */
export function scanForCodeBlockViolation(
  chunk: string,
  state: { open: boolean; lines: number },
): string | null {
  for (const line of chunk.split("\n")) {
    if (line.trim().startsWith("```")) {
      if (state.open) {
        state.open = false;
        state.lines = 0;
      } else {
        state.open = true;
        state.lines = 0;
      }
      continue;
    }
    if (state.open) {
      state.lines++;
      if (state.lines > MAX_CODE_BLOCK_LINES) {
        return `code block exceeded ${MAX_CODE_BLOCK_LINES} lines`;
      }
    }
  }
  return null;
}

/**
 * Post-hoc sanitizer for TL's final chat reply. Replaces any fenced
 * code block longer than MAX_CODE_BLOCK_LINES with a one-line marker
 * so the user sees the prose around it but not the implementation.
 * Short illustrative snippets (≤ MAX) are preserved — they're useful
 * for explaining a single decision (a function signature, a config
 * field). Whole-file dumps are not.
 *
 * Exported for tests.
 */
export function stripLongCodeBlocks(text: string): string {
  return text.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```/g, (match, body: string) => {
    const lines = body.split("\n").length;
    if (lines <= MAX_CODE_BLOCK_LINES) return match;
    return `_(removed: ${lines}-line code block — implementation belongs in a task, not chat)_`;
  });
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
