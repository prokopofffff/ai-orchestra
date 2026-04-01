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

    // MCP config
    const mcpConfigPath = path.join(workDir, ".mcp-agent.json");
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
      "\n## User Message\n",
      userMessage,
    ].join("\n");

    // Create session
    const session = await createSession({
      projectId,
      role: "tech-lead",
      model,
      worktreePath: workDir,
    });

    // Spawn Claude
    const args = [
      "--dangerously-skip-permissions",
      "--model", model,
      "--print",
      "--output-format", "text",
      "-p", fullPrompt,
    ];

    const proc = spawn("claude", args, {
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    techLeadProcesses.set(projectId, proc);

    await updateSession(session.id, { pid: proc.pid ?? null });

    // Capture output for conversation
    let output = "";
    proc.stdout?.on("data", (d) => { output += d.toString(); });
    proc.stderr?.on("data", (d) => { console.error(`[tech-lead:${slug}] ${d}`); });

    proc.on("exit", async (code) => {
      techLeadProcesses.delete(projectId);
      const status = code === 0 ? "terminated" : "crashed";
      await updateSession(session.id, { status, finishedAt: new Date() });

      // If Tech Lead produced output, store it as a message
      const trimmed = output.trim();
      if (trimmed) {
        try {
          const { rows: convRows } = await pool.query(
            "SELECT id FROM conversations WHERE project_id = $1",
            [projectId],
          );
          if (convRows.length) {
            await pool.query(
              `INSERT INTO messages (conversation_id, from_role, source, text, metadata)
               VALUES ($1, 'tech-lead', 'dashboard', $2, '{}')`,
              [convRows[0].id, trimmed],
            );
          }
        } catch (e) {
          console.error("Failed to store tech-lead response:", e);
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
