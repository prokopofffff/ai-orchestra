import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ORCHESTRA_URL = process.env.ORCHESTRA_URL ?? "http://localhost:3000";
const AGENT_ROLE = process.env.AGENT_ROLE ?? "unknown";
const PROJECT_ID = process.env.AGENT_PROJECT_ID ?? "";

const server = new McpServer({
  name: "orchestra-signal",
  version: "0.1.0",
});

server.tool(
  "signal_agent",
  "Send a signal to another agent or user. Use this for inter-agent communication: reporting task completion, asking questions, creating PRs, escalating issues.",
  {
    to: z.enum(["tech-lead", "designer", "frontend", "backend", "qa", "devops", "user"])
      .describe("Target agent role"),
    action: z.enum([
      "create_design_system", "create_design", "design_system_ready", "design_ready",
      "assign_dev", "question", "answer", "pr_created", "tests_passed", "tests_failed",
      "pr_approved", "pr_changes_requested", "task_done", "escalate",
      "deploy", "setup_cicd", "deploy_done", "cicd_ready", "notify",
    ]).describe("Signal action type"),
    taskId: z.string().uuid().optional().describe("Related task ID"),
    message: z.string().optional().describe("Additional context message"),
  },
  async ({ to, action, taskId, message }) => {
    try {
      const res = await fetch(`${ORCHESTRA_URL}/api/signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: AGENT_ROLE,
          to,
          action,
          projectId: PROJECT_ID,
          taskId,
          payload: message ? { message } : {},
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Signal rejected: ${data.error}` }], isError: true };
      }

      return { content: [{ type: "text" as const, text: `Signal sent: ${action} → ${to} (id: ${data.id})` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to send signal: ${err}` }], isError: true };
    }
  },
);

server.tool(
  "notify_user",
  "Send a notification to the user. Messages appear in both Telegram and Dashboard chat.",
  {
    message: z.string().describe("Message to send to the user"),
    taskId: z.string().uuid().optional().describe("Related task ID for context"),
  },
  async ({ message, taskId }) => {
    try {
      const res = await fetch(`${ORCHESTRA_URL}/api/signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: AGENT_ROLE,
          to: "user",
          action: "notify",
          projectId: PROJECT_ID,
          taskId,
          payload: { message },
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Notification failed: ${data.error}` }], isError: true };
      }

      return { content: [{ type: "text" as const, text: `User notified: ${message.substring(0, 80)}...` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to notify: ${err}` }], isError: true };
    }
  },
);

server.tool(
  "create_pull_request",
  "Create a GitHub Pull Request for the current branch. Push changes first, then call this tool.",
  {
    title: z.string().describe("PR title"),
    body: z.string().describe("PR description (markdown)"),
    branch: z.string().describe("Source branch name"),
    base: z.string().default("main").describe("Target branch (default: main)"),
  },
  async ({ title, body, branch, base }) => {
    try {
      const res = await fetch(`${ORCHESTRA_URL}/api/pr/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: PROJECT_ID,
          title,
          body,
          head: branch,
          base,
          agentRole: AGENT_ROLE,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `PR creation failed: ${data.error}` }], isError: true };
      }

      return { content: [{ type: "text" as const, text: `PR created: ${data.url}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to create PR: ${err}` }], isError: true };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
