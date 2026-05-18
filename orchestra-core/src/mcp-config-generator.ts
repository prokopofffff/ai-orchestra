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

// Which MCP tools each role gets
const roleTools: Record<AgentRole, string[]> = {
  "tech-lead": ["signal-tool", "task-tool"],
  designer: ["signal-tool", "task-tool"],
  frontend: ["signal-tool", "task-tool"],
  backend: ["signal-tool", "task-tool"],
  qa: ["signal-tool", "task-tool"],
  devops: ["signal-tool", "task-tool"],
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
  const orchestraUrl = `http://localhost:${config.port}`;

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
