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
import { extractText, extractAssistantText, buildCanUseTool, type DenyStreak } from "./agents/sdk-runner";
import { getAgentConfig } from "./agents/configs";
import { buildAgentDefinitions } from "./agents/role-definitions";
import { providerFor } from "./providers";
import { mintAgentJwt } from "./agent-jwt";
import { applyClaudeAuthForProject } from "./claude-auth";
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

    // Same precedence the dev-agent spawner uses: per-project Claude key
    // wins, then orchestra-wide, then env. Without this every TL chat
    // would bill the orchestra-wide key regardless of project setting.
    await applyClaudeAuthForProject(settings, config);

    const bootstrap = formatBootstrapPrompt(await buildBootstrapContext(projectId, "tech-lead"));
    const conversationHistory = await getConversationHistory(projectId);

    // Dynamic user turn = bootstrap context + conversation history + new
    // user message + a TL-specific reply rubric. The role identity / rules
    // live on the SDK agent definition (selected below via `agent: "tech-lead"`),
    // but the system prompt and the user message land in different layers
    // and the model's "be helpful" instincts win when the user asks for
    // implementation. Putting the same hard rule in the user turn — right
    // next to the user's message — keeps the constraints at equal weight.
    const userTurn = [
      bootstrap,
      conversationHistory,
      "\n## Latest User Message\n",
      userMessage,
      "",
      "## How to reply",
      "Reply with discovery questions and/or a task plan only. Do NOT paste",
      "code, file listings, `package.json` contents, `App.tsx`, directory",
      "trees, or any implementation in your reply — those belong in",
      "`mcp__orchestra-task-tool__task_create` calls for the frontend /",
      "backend / designer agents to execute. Tiny illustrative snippets",
      "(≤ 10 lines) are OK to explain a single decision; whole files are not.",
      "You have the full conversation history; do not ask the user to repeat",
      "themselves — pick up the discussion or move it forward.",
    ].join("\n");

    const session = await createSession({
      projectId,
      role: "tech-lead",
      model,
      worktreePath: workDir,
    });

    const agentJwt = await mintAgentJwt(projectId);
    const { mcpServers } = generateMcpConfig("tech-lead", config, projectId, agentJwt);

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

  // Pass only TL's own definition. Including the other 5 roles makes the
  // SDK list them as `Task`/`Agent` subagent targets in the injected tool
  // description — TL then tries to delegate via `Task`, hits the deny
  // (Task/Agent are in toolsDeny), and the deny-streak guard aborts the
  // run. Orchestra delegates via signal-tool MCP, not in-process subagents.
  const agents = buildAgentDefinitions({
    pencilEnabled: p.pencilEnabled,
    roles: ["tech-lead"],
  });
  const tlCfg = getAgentConfig("tech-lead");
  // Deny-streak abort: when canUseTool denies the same kind of tool
  // call 3 times in a row, TL is clearly stuck in a "find another way
  // to write" loop. Pull the cord and stop burning budget. We can't
  // pass an AbortController to the SDK from this dispatcher (the
  // stream object doesn't expose one), so we capture the deny event
  // and call stream.interrupt() at the next message boundary.
  let tooManyDenies: DenyStreak | null = null;
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
      canUseTool: buildCanUseTool(
        tlCfg.scope.denied, tlCfg.toolsDeny ?? [], p.workDir,
        (streak) => { tooManyDenies = streak; },
      ),
      mcpServers: Object.fromEntries(
        Object.entries(p.mcpServers).map(([name, s]) => [
          name,
          { type: "stdio" as const, command: s.command, args: s.args, env: s.env },
        ]),
      ),
    },
  });

  techLeadQueries.set(p.projectId, stream);
  // Mid-stream code-block guard. Tracks whether we're inside a fenced
  // block and how many body lines have streamed since the opening fence.
  // Crossing MAX_CODE_BLOCK_LINES counts as TL trying to implement the
  // feature in chat (the failure mode we keep seeing); we abort the run
  // immediately and replace the partial reply with a system note.
  const guard = createGuardState();
  let violation: string | null = null;

  try {
    for await (const message of stream) {
      // Diagnose MCP wiring once at session init: which servers actually
      // connected, and what tool names the model sees. If a server failed
      // to spawn (bad path, missing dist, crashing env) it shows up here
      // with status != "connected" and its tools won't be in the tools list.
      if (message.type === "system" && (message as { subtype?: string }).subtype === "init") {
        const init = message as unknown as {
          tools?: string[];
          mcp_servers?: { name: string; status: string }[];
        };
        const orchestraTools = (init.tools ?? []).filter((t) => t.startsWith("mcp__orchestra"));
        appendLog(p.projectId, p.sessionId, "tech-lead", "system",
          `MCP init: servers=${JSON.stringify(init.mcp_servers ?? [])}  orchestra_tools=${JSON.stringify(orchestraTools)}`);
      }
      if (message.type !== "assistant") continue;
      const logText = extractText(message.message.content);
      if (logText) appendLog(p.projectId, p.sessionId, "tech-lead", "stdout", logText);
      const chatText = extractAssistantText(message.message.content);
      if (chatText && !violation) {
        violation = scanForCodeBlockViolation(chatText, guard);
        if (violation) {
          appendLog(p.projectId, p.sessionId, "tech-lead", "error",
            `RUN ABORTED: ${violation}. Chat reply was pasting implementation instead of creating tasks.`);
          await stream.interrupt().catch(() => { /* already over */ });
          break;
        }
        // Stream this fragment to chat as its own message — landed in the
        // conversation the moment TL emitted it, so the user can read TL's
        // running commentary instead of waiting for the whole run to
        // finish. Per-chunk stripLongCodeBlocks is defense in depth against
        // a single block that snuck under the streaming guard.
        const chunk = stripLongCodeBlocks(chatText).trim();
        if (chunk) {
          await notify({
            projectId: p.projectId,
            text: chunk,
            priority: "high",
            fromRole: "tech-lead",
          }).catch((err) => log.error({ err, projectId: p.projectId }, "tech-lead stream notify failed"));
        }
      }
      // canUseTool flagged a deny streak — TL is hammering denied tools.
      // Pull the cord and surface what it tried so the operator can see.
      // Cast away the closure-mutated narrowing — TS thinks tooManyDenies
      // is always null because only the assignment from canUseTool's
      // callback mutates it, and the analyzer can't see across that boundary.
      const denies = tooManyDenies as DenyStreak | null;
      if (denies && !violation) {
        const breakdown = Array.from(denies.byTool.entries())
          .map(([t, n]) => `${t}×${n}`)
          .join(", ");
        violation = `${denies.total} denied tool calls in a row (${breakdown})`;
        appendLog(p.projectId, p.sessionId, "tech-lead", "error",
          `RUN ABORTED: ${violation}. TL was looping on denied tools instead of using task-tool / signal-tool.`);
        await stream.interrupt().catch(() => { /* already over */ });
        break;
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
    // The TL fragments that already streamed to the chat stay there as a
    // breadcrumb of what TL was doing before the abort. Append a single
    // system message explaining the abort + how the user should re-ask.
    // Next TL turn will see this in its conversation history as feedback.
    await notify({
      projectId: p.projectId,
      text:
        "⚠️ Tech Lead started writing code in chat (forbidden) — the run was aborted. " +
        "Tech Lead's job is to create tasks via `task_create` and delegate to the frontend / backend / designer agents, not to paste implementations. " +
        "Try re-asking with: \"create tasks for the dev team — don't write code yourself.\"",
      priority: "high",
      fromRole: "system",
    }).catch((err) => log.error({ err, projectId: p.projectId }, "violation notify failed"));
  }
}

const MAX_CODE_BLOCK_LINES = 10;
const MAX_TEXT_BLOCK_LINES = 50;

/**
 * Programming-language fence tags that trigger the strict implementation
 * guard. Fences without a tag, or with a tag outside this set (`text`,
 * `tree`, `mermaid`, …), are treated as diagrams / prose — TL legitimately
 * uses them to draw task trees, state machines, dependency graphs. They
 * still have a cap (MAX_TEXT_BLOCK_LINES) to stop a model that decides to
 * dump a 200-line plan, but it's an order of magnitude looser than for code.
 */
const CODE_LANGS = new Set([
  "js", "ts", "jsx", "tsx", "javascript", "typescript", "mjs", "cjs",
  "py", "python", "rb", "ruby", "java", "kt", "kotlin", "swift",
  "rs", "rust", "go", "golang",
  "c", "cpp", "c++", "h", "hpp", "cs", "csharp", "php",
  "sh", "bash", "zsh", "shell", "ps1", "powershell", "fish",
  "sql", "html", "htm", "css", "scss", "sass", "less",
  "yaml", "yml", "json", "jsonc", "toml", "xml", "ini", "env",
  "dockerfile", "makefile", "vue", "svelte", "astro",
  "ex", "exs", "elixir", "erl", "erlang", "hs", "haskell", "elm",
  "lua", "perl", "pl", "r", "jl", "julia", "nim", "zig", "dart",
  "groovy", "gradle", "scala", "clj", "cljs", "clojure",
  "m", "mm", "objc", "objective-c", "proto", "graphql",
]);

function isCodeFence(langTag: string): boolean {
  return CODE_LANGS.has(langTag.trim().toLowerCase());
}

export type CodeGuardState = { open: boolean; lines: number; isCode: boolean };

export function createGuardState(): CodeGuardState {
  return { open: false, lines: 0, isCode: false };
}

/**
 * Walk a chunk of newly-streamed text and update the multi-call guard
 * tracking whether the model is currently inside a fenced block, how many
 * body lines have streamed, and whether the fence is a code-language one.
 * Returns a violation reason if the current block crosses the role-appropriate
 * cap, null otherwise.
 *
 * Exported for tests.
 */
export function scanForCodeBlockViolation(
  chunk: string,
  state: CodeGuardState,
): string | null {
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      if (state.open) {
        state.open = false;
        state.lines = 0;
        state.isCode = false;
      } else {
        state.open = true;
        state.lines = 0;
        state.isCode = isCodeFence(trimmed.slice(3));
      }
      continue;
    }
    if (state.open) {
      state.lines++;
      const cap = state.isCode ? MAX_CODE_BLOCK_LINES : MAX_TEXT_BLOCK_LINES;
      if (state.lines > cap) {
        return state.isCode
          ? `code block exceeded ${MAX_CODE_BLOCK_LINES} lines`
          : `text/diagram block exceeded ${MAX_TEXT_BLOCK_LINES} lines`;
      }
    }
  }
  return null;
}

/**
 * Post-hoc sanitizer for TL's final chat reply. Replaces over-cap fenced
 * blocks with a one-line marker so the user sees the prose around them but
 * not the dump. Short snippets (≤ cap) are preserved — they're useful
 * for explaining a decision. Caps differ by fence kind: code-language
 * fences get the strict cap; text/diagram fences get a looser one.
 *
 * Exported for tests.
 */
export function stripLongCodeBlocks(text: string): string {
  return text.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n```/g, (match, lang: string, body: string) => {
    const lines = body.split("\n").length;
    const code = isCodeFence(lang);
    const cap = code ? MAX_CODE_BLOCK_LINES : MAX_TEXT_BLOCK_LINES;
    if (lines <= cap) return match;
    return code
      ? `_(removed: ${lines}-line code block — implementation belongs in a task, not chat)_`
      : `_(removed: ${lines}-line text block — too long; trim or describe instead)_`;
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
