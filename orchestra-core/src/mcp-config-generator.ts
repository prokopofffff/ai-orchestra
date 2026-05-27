import fs from "node:fs";
import path from "node:path";
import { type AgentRole, type Config } from "./config";

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Resolve where mcp-tools/ lives. Two valid layouts:
 *   - Docker:    cwd=/app, mounted ./mcp-tools at /app/mcp-tools     → <cwd>/mcp-tools
 *   - Local dev: cwd=orchestra-core/, mcp-tools is its sibling       → <cwd>/../mcp-tools
 *
 * Without this fallback, `pnpm --filter orchestra-core dev` spawns each MCP
 * server with `node <orchestra-core>/mcp-tools/<tool>/dist/index.js`, the
 * path doesn't exist, and the SDK reports the server's status as "failed"
 * with `orchestra_tools=[]` in the init log. The TL then says "I don't have
 * access to `mcp__orchestra-task-tool__task_create`" — accurate, because
 * the server never spawned.
 *
 * MCP_TOOLS_ROOT env var (when set) overrides the search and is used as-is.
 */
const MCP_TOOLS_ROOT = (() => {
  if (process.env.MCP_TOOLS_ROOT) return process.env.MCP_TOOLS_ROOT;
  const candidates = [
    path.join(process.cwd(), "mcp-tools"),
    path.join(process.cwd(), "..", "mcp-tools"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]; // best guess — fails loudly via init-log status
})();

// Which MCP tools each role gets. reference-tool is included for every role
// — it's read-only (backend enforces the ACL); irrelevant for roles in
// projects with no referenceProjects configured (the tools just return
// "no references" and add no run-cost). Easier than per-role gating which
// would surprise users who later link a project for the qa/devops agent.
const roleTools: Record<AgentRole, string[]> = {
  // preview-tool gives tech-lead programmatic access to the per-project
  // preview contour (status / deploy / logs). Restricted to tech-lead so
  // dev agents can't redeploy each other's preview mid-PR — the TL
  // decides when to spin up a verification contour.
  "tech-lead": ["signal-tool", "task-tool", "reference-tool", "preview-tool"],
  designer: ["signal-tool", "task-tool", "reference-tool"],
  frontend: ["signal-tool", "task-tool", "reference-tool"],
  backend: ["signal-tool", "task-tool", "reference-tool"],
  qa: ["signal-tool", "task-tool", "reference-tool"],
  devops: ["signal-tool", "task-tool", "reference-tool"],
};

// Pencil MCP is loaded automatically via Claude Code plugin (frontend-design@claude-plugins-official).
// No need to add to MCP config — it's available when Pencil desktop app is running.
// Designer gets full access, frontend gets read access (enforced by prompt instructions).

export function generateMcpConfig(
  role: AgentRole,
  config: Config,
  projectId?: string,
  /**
   * Per-spawn JWT to authenticate MCP tools' callbacks into /api/*. Without
   * this every fetch from the MCP tool process gets a 401 from the auth
   * preHandler. Pass `undefined` only in tests that don't exercise the
   * agent → API path.
   */
  agentJwt?: string,
): McpConfig {
  const tools = roleTools[role];
  // Force IPv4 loopback rather than "localhost". In Alpine-based containers
  // (and many distros) "localhost" resolves to ::1 first; Fastify binds to
  // 0.0.0.0 only, so IPv6 lookups hit "connection refused" and every MCP
  // tool callback into orchestra-core silently fails. Symptom: agents say
  // "проверка отменена на стороне MCP-инструмента" and stop using the
  // signal/task tools entirely. Hard-coding 127.0.0.1 sidesteps the dual-
  // stack ambiguity for this loopback-only call. External callers still
  // use the public hostname — this affects only the agent → orchestra path.
  const orchestraUrl = `http://127.0.0.1:${config.port}`;

  const mcpServers: Record<string, McpServerConfig> = {};

  // Orchestra tools (signal + task)
  for (const tool of tools) {
    const toolDir = path.join(MCP_TOOLS_ROOT, tool);
    mcpServers[`orchestra-${tool}`] = {
      command: "node",
      args: [path.join(toolDir, "dist", "index.js")],
      env: {
        ORCHESTRA_URL: orchestraUrl,
        AGENT_ROLE: role,
        AGENT_PROJECT_ID: projectId ?? "",
        ORCHESTRA_JWT: agentJwt ?? "",
      },
    };
  }

  return { mcpServers };
}
