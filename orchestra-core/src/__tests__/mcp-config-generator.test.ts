import { describe, it, expect } from "vitest";
import { generateMcpConfig } from "../mcp-config-generator";
import { configSchema } from "../config";

const config = configSchema.parse({
  databaseUrl: "postgres://localhost:5432/test",
  port: 3000,
});

describe("mcp-config-generator", () => {
  it("generates config with signal-tool and task-tool for backend", () => {
    const mcp = generateMcpConfig("backend", config, "project-123");
    expect(mcp.mcpServers["orchestra-signal-tool"]).toBeDefined();
    expect(mcp.mcpServers["orchestra-task-tool"]).toBeDefined();
  });

  it("sets correct env variables", () => {
    const mcp = generateMcpConfig("frontend", config, "proj-456");
    const signalEnv = mcp.mcpServers["orchestra-signal-tool"].env!;
    expect(signalEnv.AGENT_ROLE).toBe("frontend");
    expect(signalEnv.AGENT_PROJECT_ID).toBe("proj-456");
    expect(signalEnv.ORCHESTRA_URL).toBe("http://localhost:3000");
  });

  it("generates config for all roles", () => {
    const roles = ["tech-lead", "designer", "frontend", "backend", "qa", "devops"] as const;
    for (const role of roles) {
      const mcp = generateMcpConfig(role, config);
      expect(Object.keys(mcp.mcpServers).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("uses node as command", () => {
    const mcp = generateMcpConfig("backend", config);
    for (const server of Object.values(mcp.mcpServers)) {
      expect(server.command).toBe("node");
      expect(server.args[0]).toContain("dist/index.js");
    }
  });
});
