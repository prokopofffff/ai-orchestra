import { writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AgentRole, AgentRoleSchema } from "./session-manager.js";

export const McpServerEntrySchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string()).optional(),
});
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;

export const McpConfigSchema = z.object({
  mcpServers: z.record(McpServerEntrySchema),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

const ORCHESTRA_URL = process.env.ORCHESTRA_URL || "http://localhost:3000";
const OPENPROJECT_URL = process.env.OPENPROJECT_URL || "http://localhost:8080";
const OPENPROJECT_API_KEY = process.env.OPENPROJECT_API_KEY || "";
const MCP_TOOLS_DIR = process.env.MCP_TOOLS_DIR || "/app/mcp-tools";

function baseServers(role: AgentRole): Record<string, McpServerEntry> {
  return {
    signal: {
      command: "node",
      args: [path.join(MCP_TOOLS_DIR, "signal-tool/dist/index.js")],
      env: {
        ORCHESTRA_URL,
        AGENT_ROLE: role,
      },
    },
    openproject: {
      command: "node",
      args: [path.join(MCP_TOOLS_DIR, "openproject-tool/dist/index.js")],
      env: {
        OPENPROJECT_URL,
        OPENPROJECT_API_KEY,
      },
    },
  };
}

function pencilServers(): Record<string, McpServerEntry> {
  // Pencil MCP is assumed to be available as a system-installed MCP server
  // The exact command depends on the Pencil installation
  return {
    pencil: {
      command: "pencil-mcp",
      args: [],
      env: {},
    },
  };
}

const ROLE_SERVERS: Record<AgentRole, () => Record<string, McpServerEntry>> = {
  "tech-lead": (role = "tech-lead" as AgentRole) => ({
    ...baseServers(role),
  }),
  designer: (role = "designer" as AgentRole) => ({
    ...baseServers(role),
    ...pencilServers(),
  }),
  frontend: (role = "frontend" as AgentRole) => ({
    ...baseServers(role),
    ...pencilServers(), // read-only access to designs
  }),
  backend: (role = "backend" as AgentRole) => ({
    ...baseServers(role),
  }),
  qa: (role = "qa" as AgentRole) => ({
    ...baseServers(role),
  }),
  devops: (role = "devops" as AgentRole) => ({
    ...baseServers(role),
  }),
};

export function generateMcpConfig(role: AgentRole): McpConfig {
  const parsedRole = AgentRoleSchema.parse(role);
  const serversFn = ROLE_SERVERS[parsedRole];
  const servers = serversFn();

  return McpConfigSchema.parse({ mcpServers: servers });
}

export function writeMcpConfig(role: AgentRole, outputDir: string): string {
  const config = generateMcpConfig(role);
  const filePath = path.join(outputDir, `mcp-config-${role}.json`);
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
  return filePath;
}

export function generateAllMcpConfigs(outputDir: string): string[] {
  const roles = AgentRoleSchema.options;
  return roles.map((role) => writeMcpConfig(role, outputDir));
}
