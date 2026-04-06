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

const MCP_TOOLS_ROOT = process.env.MCP_TOOLS_ROOT
  ?? path.join(process.cwd(), "mcp-tools");

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
      },
    };
  }

  return { mcpServers };
}
