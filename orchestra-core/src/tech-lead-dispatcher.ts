import fs from "node:fs";
import { type Config, getEffortForRole } from "./config";
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
import { ensureRepo, ensureTempDir, defaultRepoDir } from "./repo-manager";
import { providerFor, buildGitProviderEnv } from "./providers";
import { mintAgentJwt } from "./agent-jwt";
import { resolveRuntimeForRole } from "./agents/runtime/resolver";
import {
  logRuntimeEvent,
  recordRuntimeCost,
  type ObserverContext,
} from "./agents/runtime/observers";
import { resolvePerRunBudgetUsd } from "./limits";
import { logBackgroundError } from "./error-handler";
import type { AgentRuntime, RuntimeEvent } from "./agents/runtime/types";
import type { ProjectSettings } from "@ai-orchestra/shared";

// In-flight Tech Lead conversations per project — used by interruptTechLead()
// to cancel a run while it's mid-stream. Previously held SDK Query handles;
// the runtime exposes the same control surface via AbortController.
const techLeadAborts = new Map<string, AbortController>();

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
    if (!projRows.length) return { action: "error", error: "Проект не найден" };

    const { slug, repo_url: repoUrl, local_path: localPath, settings } = projRows[0];
    const effort = getEffortForRole("tech-lead", settings as Record<string, unknown>);

    // Resolve provider+model+auth once, up-front. Same path the spawner
    // uses — picks Claude or Codex based on settings.models["tech-lead"]
    // and builds the per-spawn env (CLAUDE_CONFIG_DIR / CODEX_HOME).
    const resolved = await resolveRuntimeForRole({
      projectId, role: "tech-lead", settings, config,
    });
    if (!resolved.ok) {
      notify({
        projectId, text: resolved.reason, priority: "high", fromRole: "system",
      }).catch(() => { /* best-effort */ });
      return { action: "error", error: resolved.reason };
    }
    const model = resolved.resolved.model;

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
      workDir = await ensureRepo(provider.tokenizeCloneUrl(), defaultRepoDir(slug));
    } else {
      workDir = ensureTempDir(slug);
    }

    // Filesystem preflight: the configured `local_path` may not exist in the
    // container (typical failure: user typed a host path that was never
    // mounted, or a container rebuild wiped a path that wasn't on a docker
    // volume). Codex/Claude CLIs error cryptically when `--cd` points at a
    // missing dir — bail here with an actionable chat message instead of
    // burning a session row that produces no visible reply.
    if (!fs.existsSync(workDir)) {
      const reason =
        `Рабочая директория \`${workDir}\` не существует. ` +
        `Откройте Настройки проекта и выберите путь, который смонтирован в контейнер ` +
        `(или очистите Локальный путь — тогда orchestra создаст временную папку).`;
      notify({ projectId, text: reason, priority: "high", fromRole: "system" })
        .catch(() => { /* best-effort */ });
      return { action: "error", error: reason };
    }

    // Auth preflight + env resolution already happened in `resolved` above.
    const bootstrap = formatBootstrapPrompt(await buildBootstrapContext(projectId, "tech-lead"));
    const conversationHistory = await getConversationHistory(projectId);

    // Dynamic user turn = bootstrap context + conversation history + new
    // user message + a TL-specific reply rubric. The role identity / rules
    // live on the agent definition (selected below via `agent: "tech-lead"`),
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

    // Merge git-provider env vars (GITLAB_TOKEN / GITHUB_TOKEN / generic
    // GIT_PROVIDER_TOKEN) into the spawn env so the agent can actually
    // talk to its configured remote. Without this, local_path projects
    // come in with an SSH origin and the agent can't fetch/push because
    // no key is reachable from inside the container.
    const spawnEnv = {
      ...resolved.resolved.spawnEnv,
      ...buildGitProviderEnv(repoUrl as string | null, settings),
    };

    // Run the conversation in the background — the HTTP request that triggered
    // this returns immediately; the tech-lead's reply arrives via notify().
    void runTechLead({
      projectId, sessionId: session.id, model, effort, workDir,
      userTurn, mcpServers, pencilEnabled: config.pencilEnabled,
      settings,
      runtime: resolved.resolved.runtime,
      spawnEnv,
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
  effort?: "low" | "medium" | "high" | "max";
  workDir: string;
  userTurn: string;
  pencilEnabled?: boolean;
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  settings: unknown;
  runtime: AgentRuntime;
  spawnEnv: Record<string, string | undefined>;
}): Promise<void> {
  appendLog(p.projectId, p.sessionId, "tech-lead", "system", `tech-lead run: model=${p.model}`);

  // Mid-stream code-block guard. Tracks whether we're inside a fenced
  // block and how many body lines have streamed since the opening fence.
  // Crossing MAX_CODE_BLOCK_LINES counts as TL trying to implement the
  // feature in chat (the failure mode we keep seeing); we abort the run
  // immediately and replace the partial reply with a system note.
  const guard = createGuardState();
  let violation: string | null = null;

  // Per-project abort controller. Stored in techLeadAborts so an external
  // /tech-lead/interrupt call (or a violation below) can cancel mid-stream.
  // Replaces the SDK's Query.interrupt() handle 1:1.
  const abortController = new AbortController();
  techLeadAborts.set(p.projectId, abortController);

  const ctx: ObserverContext = {
    projectId: p.projectId,
    sessionId: p.sessionId,
    taskId: null,
    role: "tech-lead",
    worktree: p.workDir,
  };
  const maxBudgetUsd = resolvePerRunBudgetUsd("tech-lead", p.settings);

  const onEvent = async (evt: RuntimeEvent): Promise<void> => {
    // Standard logs (init/MCP, assistant text, tool calls, result + cost).
    logRuntimeEvent(ctx, evt);
    await recordRuntimeCost(ctx, evt, { maxBudgetUsd });

    // TL-specific: stream assistant turns to the chat as they arrive, while
    // running the code-block guard against each chunk. A violation triggers
    // an abort; the partial reply that already streamed stays in the chat
    // as a breadcrumb, and a system note about the abort is appended after.
    if (evt.type === "assistant_text" && !violation) {
      violation = scanForCodeBlockViolation(evt.text, guard);
      if (violation) {
        appendLog(p.projectId, p.sessionId, "tech-lead", "error",
          `RUN ABORTED: ${violation}. Chat reply was pasting implementation instead of creating tasks.`);
        abortController.abort(`code-block guard: ${violation}`);
        return;
      }
      const chunk = stripLongCodeBlocks(evt.text).trim();
      if (chunk) {
        await notify({
          projectId: p.projectId,
          text: chunk,
          priority: "high",
          fromRole: "tech-lead",
        }).catch((err) => log.error({ err, projectId: p.projectId }, "tech-lead stream notify failed"));
      }
    }
  };

  try {
    await p.runtime.run({
      projectId: p.projectId,
      taskId: null,
      sessionId: p.sessionId,
      role: "tech-lead",
      model: p.model,
      effort: p.effort,
      cwd: p.workDir,
      prompt: p.userTurn,
      pencilEnabled: p.pencilEnabled,
      mcpServers: p.mcpServers,
      settings: p.settings,
      abortSignal: abortController.signal,
      spawnEnv: p.spawnEnv,
    }, onEvent);
    await updateSession(p.sessionId, {
      status: violation ? "crashed" : "terminated",
      finishedAt: new Date(),
    });
  } catch (err) {
    await updateSession(p.sessionId, { status: "crashed", finishedAt: new Date() });
    log.error({ err, projectId: p.projectId, sessionId: p.sessionId }, "tech-lead run failed");
  } finally {
    techLeadAborts.delete(p.projectId);
  }

  if (violation) {
    // The TL fragments that already streamed to the chat stay there as a
    // breadcrumb of what TL was doing before the abort. Append a single
    // system message explaining the abort + how the user should re-ask.
    // Next TL turn will see this in its conversation history as feedback.
    await notify({
      projectId: p.projectId,
      text:
        "⚠️ Tech Lead начал писать код в чате (запрещено) — запуск прерван. " +
        "Задача Tech Lead — создавать таски через `task_create` и делегировать их фронтенд / бэкенд / дизайнер агентам, а не вставлять реализацию в чат. " +
        "Попробуйте переформулировать: \"создай таски для команды разработки — не пиши код сам.\"",
      priority: "high",
      fromRole: "system",
    }).catch((err) => logBackgroundError("tech-lead:violation-notify", err, p.projectId));
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
  const ctrl = techLeadAborts.get(projectId);
  if (!ctrl) return false;
  ctrl.abort("user interrupted tech-lead");
  techLeadAborts.delete(projectId);
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
