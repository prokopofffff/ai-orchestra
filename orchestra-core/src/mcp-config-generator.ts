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
  return {
    pencil: {
      command: "pencil-mcp",
      args: [],
      env: {},
    },
  };
}

const ROLES_WITH_PENCIL: ReadonlySet<AgentRole> = new Set(["designer", "frontend"]);

function serversForRole(role: AgentRole): Record<string, McpServerEntry> {
  const servers = baseServers(role);

  if (ROLES_WITH_PENCIL.has(role)) {
    Object.assign(servers, pencilServers());
  }

  return servers;
}

export function generateMcpConfig(role: AgentRole): McpConfig {
  const parsedRole = AgentRoleSchema.parse(role);
  const servers = serversForRole(parsedRole);
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
