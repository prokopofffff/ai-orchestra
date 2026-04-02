import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Config, getModelForRole } from "./config.js";
import {
  createSession,
  updateSession,
  getActiveSessionForRole,
  type Session,
} from "./session-manager.js";
import { buildBootstrapContext, formatBootstrapPrompt } from "./session-context.js";
import { generateMcpConfig } from "./mcp-config-generator.js";
import { getPool } from "./db.js";
import { notify } from "./notification-hub.js";
import { appendLog } from "./logger.js";

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT
  ?? path.join(process.env.HOME ?? "/tmp", "orchestra-workspaces");

// Track running Tech Lead processes
const techLeadProcesses = new Map<string, ChildProcess>();

/**
 * Dispatch Tech Lead for a project. Called when user sends a message.
 * - If Tech Lead is already running, sends a signal to resume (it will pick up pending messages)
 * - If not running, spawns a new Tech Lead session
 */
export async function dispatchTechLead(
  projectId: string,
  userMessage: string,
  config: Config,
): Promise<{ action: "already_running" | "spawned" | "error"; sessionId?: string; error?: string }> {
  try {
    // Check if Tech Lead already running
    const existing = await getActiveSessionForRole(projectId, "tech-lead");
    if (existing) {
      // Tech Lead is running — it will pick up the message from pending signals/conversations
      // Send a signal to make sure it wakes up
      await getPool().query(
        `INSERT INTO signals (project_id, from_role, to_role, action, payload)
         VALUES ($1, 'user', 'tech-lead', 'notify', $2)`,
        [projectId, JSON.stringify({ message: userMessage })],
      );
      return { action: "already_running", sessionId: existing.id };
    }

    // Spawn new Tech Lead
    const pool = getPool();
    const { rows: projRows } = await pool.query(
      "SELECT slug, repo_url, settings FROM projects WHERE id = $1",
      [projectId],
    );
    if (!projRows.length) return { action: "error", error: "Project not found" };

    const { slug, repo_url: repoUrl, settings } = projRows[0];
    const model = getModelForRole(config, "tech-lead", settings as Record<string, unknown>);

    // Prepare working directory
    const workDir = repoUrl
      ? await ensureRepoClone(repoUrl, slug)
      : ensureTempDir(slug);

    // Build context
    const ctx = await buildBootstrapContext(projectId, "tech-lead");
    const bootstrapPrompt = formatBootstrapPrompt(ctx);

    // Fetch conversation history
    const conversationHistory = await getConversationHistory(projectId);

    // MCP config (outside workDir so git operations don't delete it)
    const mcpConfigDir = path.join(WORKSPACES_ROOT, slug, ".mcp-configs");
    fs.mkdirSync(mcpConfigDir, { recursive: true });
    const mcpConfigPath = path.join(mcpConfigDir, "tech-lead.json");
    const mcpConfig = generateMcpConfig("tech-lead", config, projectId);
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // System prompt
    const promptPath = path.join(process.cwd(), "prompts", "tech-lead.md");
    let systemPrompt = "";
    if (fs.existsSync(promptPath)) {
      systemPrompt = fs.readFileSync(promptPath, "utf-8");
    }

    const fullPrompt = [
      systemPrompt,
      "\n---\n",
      bootstrapPrompt,
      conversationHistory,
      "\n## Latest User Message\n",
      userMessage,
      "\n\nRespond to the user's latest message above. You have the full conversation history — do NOT ask the user to repeat themselves. Continue where the conversation left off.",
    ].join("\n");

    // Create session
    const session = await createSession({
      projectId,
      role: "tech-lead",
      model,
      worktreePath: workDir,
    });

    // Spawn Claude with MCP tools for task/signal management
    const args = [
      "--dangerously-skip-permissions",
      "--model", model,
        "--mcp-config", mcpConfigPath,
      "-p", fullPrompt,
    ];

    const proc = spawn("claude", args, {
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    techLeadProcesses.set(projectId, proc);

    await updateSession(session.id, { pid: proc.pid ?? null });

    // Capture output
    let output = "";
    proc.stdout?.on("data", (d) => {
      const chunk = d.toString();
      output += chunk;
      appendLog(projectId, session.id, "tech-lead", "stdout", chunk);
    });
    proc.stderr?.on("data", (d) => {
      const chunk = d.toString();
      appendLog(projectId, session.id, "tech-lead", "stderr", chunk);
    });

    proc.on("exit", async (code) => {
      techLeadProcesses.delete(projectId);
      const status = code === 0 ? "terminated" : "crashed";
      await updateSession(session.id, { status, finishedAt: new Date() });
      appendLog(projectId, session.id, "tech-lead", "system", `Process exited with code ${code}`);

      // Store response in conversation + push to Telegram
      const trimmed = output.trim();
      if (trimmed) {
        try {
          await notify({
            projectId,
            text: trimmed,
            priority: "high",
            fromRole: "tech-lead",
          });
        } catch (e) {
          console.error("Failed to store/notify tech-lead response:", e);
        }
      }
    });

    return { action: "spawned", sessionId: session.id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Failed to dispatch tech-lead:", msg);
    return { action: "error", error: msg };
  }
}

async function ensureRepoClone(repoUrl: string, slug: string): Promise<string> {
  const repoDir = path.join(WORKSPACES_ROOT, slug, "repo");
  if (fs.existsSync(path.join(repoDir, ".git"))) return repoDir;

  fs.mkdirSync(path.dirname(repoDir), { recursive: true });

  // Inject GitHub token into URL if available
  let cloneUrl = repoUrl;
  const token = process.env.GITHUB_TOKEN;
  if (token && cloneUrl.startsWith("https://github.com/")) {
    cloneUrl = cloneUrl.replace("https://github.com/", `https://${token}@github.com/`);
  }

  const { execSync } = await import("node:child_process");
  execSync(`git clone "${cloneUrl}" "${repoDir}"`, { stdio: "pipe" });
  return repoDir;
}

function ensureTempDir(slug: string): string {
  const dir = path.join(WORKSPACES_ROOT, slug, "workspace");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function getConversationHistory(projectId: string): Promise<string> {
  const pool = getPool();

  const { rows: convRows } = await pool.query(
    "SELECT id FROM conversations WHERE project_id = $1",
    [projectId],
  );
  if (!convRows.length) return "";

  // Get last 30 messages for context
  const { rows } = await pool.query(
    `SELECT from_role, source, text, created_at FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC LIMIT 30`,
    [convRows[0].id],
  );

  if (!rows.length) return "";

  // Reverse to chronological order
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
