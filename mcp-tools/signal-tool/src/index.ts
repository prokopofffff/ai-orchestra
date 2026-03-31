import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ORCHESTRA_URL = process.env.ORCHESTRA_URL || "http://localhost:3000";

const server = new McpServer({
  name: "signal-tool",
  version: "0.1.0",
});

server.tool(
  "signal_agent",
  "Send a signal to another agent in the orchestra. Use this to communicate with other agents (tech-lead, frontend, backend, qa, devops) or the user.",
  {
    to: z
      .enum(["tech-lead", "designer", "frontend", "backend", "qa", "devops", "user"])
      .describe("The recipient agent role or 'user' to message the user"),
    action: z
      .string()
      .describe(
        "The action type: assign_dev, create_design, create_design_system, design_ready, design_system_ready, question, answer, pr_created, tests_passed, pr_approved, pr_changes_requested, task_done, escalate, deploy, setup_cicd"
      ),
    project_id: z.string().optional().describe("The project identifier"),
    task_id: z
      .string()
      .optional()
      .describe("The OpenProject task/work package ID"),
    message: z.string().describe("The message or context for the signal"),
  },
  async ({ to, action, project_id, task_id, message }) => {
    const from = process.env.AGENT_ROLE || "unknown";

    const body = {
      from,
      to,
      action,
      context: {
        project_id,
        task_id,
        message,
      },
    };

    try {
      const response = await fetch(`${ORCHESTRA_URL}/api/signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const result = (await response.json()) as { status: string; id: string };

      return {
        content: [
          {
            type: "text" as const,
            text: `Signal sent to ${to}: ${action}\nStatus: ${result.status}\nSignal ID: ${result.id}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to send signal: ${(err as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "notify_user",
  "Send a notification message to the user via Telegram.",
  {
    message: z.string().describe("The message to send to the user"),
  },
  async ({ message }) => {
    const from = process.env.AGENT_ROLE || "unknown";

    try {
      await fetch(`${ORCHESTRA_URL}/api/signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: "user",
          action: "notify",
          context: { message },
        }),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `User notified: ${message}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to notify user: ${(err as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
