import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ORCHESTRA_URL = process.env.ORCHESTRA_URL ?? "http://localhost:3000";
const PROJECT_ID = process.env.AGENT_PROJECT_ID ?? "";

const server = new McpServer({
  name: "orchestra-task",
  version: "0.1.0",
});

const AGENT_ROLE = process.env.AGENT_ROLE ?? "";

async function apiCall(path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${ORCHESTRA_URL}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Role": AGENT_ROLE,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

// ─── Task Tools ───

server.tool(
  "task_list",
  "List tasks in the current project. Filter by state, type, or assignee role.",
  {
    state: z.string().optional().describe("Filter by state (e.g. 'in_development', 'pr_created')"),
    type: z.string().optional().describe("Filter by type (e.g. 'task', 'bug', 'feature')"),
    assigneeRole: z.string().optional().describe("Filter by assignee role"),
  },
  async ({ state, type, assigneeRole }) => {
    const params = new URLSearchParams({ projectId: PROJECT_ID });
    if (state) params.set("state", state);
    if (type) params.set("type", type);
    if (assigneeRole) params.set("assigneeRole", assigneeRole);

    const tasks = await apiCall(`/tasks?${params}`);
    const summary = Array.isArray(tasks)
      ? tasks.map((t: { title: string; state: string; assigneeRole?: string; id: string }) =>
          `- [${t.state}] ${t.title} (${t.assigneeRole ?? "unassigned"}) id:${t.id}`
        ).join("\n")
      : JSON.stringify(tasks);

    return { content: [{ type: "text" as const, text: summary || "No tasks found" }] };
  },
);

server.tool(
  "task_get",
  "Get details of a specific task by ID.",
  { taskId: z.string().uuid().describe("Task ID") },
  async ({ taskId }) => {
    const task = await apiCall(`/tasks/${taskId}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
  },
);

server.tool(
  "task_create",
  "Create a new task in the current project.",
  {
    title: z.string().describe("Task title"),
    description: z.string().optional().describe("Task description with acceptance criteria"),
    type: z.enum(["epic", "task", "subtask", "bug", "feature"]).default("task").describe("Task type"),
    priority: z.enum(["low", "normal", "high", "immediate"]).default("normal").describe("Priority"),
    assigneeRole: z.enum(["tech-lead", "designer", "frontend", "backend", "qa", "devops"]).optional().describe("Assign to role"),
    parentId: z.string().uuid().optional().describe("Parent task ID (for subtasks)"),
    blockedBy: z.array(z.string().uuid()).optional().describe("Task IDs that must complete first"),
  },
  async (params) => {
    const task = await apiCall("/tasks", "POST", { ...params, projectId: PROJECT_ID });
    return { content: [{ type: "text" as const, text: `Task created: ${task.title} (id: ${task.id})` }] };
  },
);

server.tool(
  "task_update",
  "Update a task's state, priority, description, or other fields.",
  {
    taskId: z.string().uuid().describe("Task ID"),
    state: z.string().optional().describe("New state"),
    priority: z.enum(["low", "normal", "high", "immediate"]).optional().describe("New priority"),
    description: z.string().optional().describe("Updated description"),
    assigneeRole: z.string().optional().describe("New assignee role"),
    branchName: z.string().optional().describe("Git branch name"),
    prUrl: z.string().optional().describe("Pull request URL"),
  },
  async ({ taskId, ...updates }) => {
    const task = await apiCall(`/tasks/${taskId}`, "PATCH", updates);
    return { content: [{ type: "text" as const, text: `Task updated: ${task.title} → ${task.state}` }] };
  },
);

server.tool(
  "task_add_comment",
  "Add a comment to a task. Use for status updates, questions, or notes.",
  {
    taskId: z.string().uuid().describe("Task ID"),
    body: z.string().describe("Comment text"),
  },
  async ({ taskId, body }) => {
    const author = process.env.AGENT_ROLE ?? "agent";
    await apiCall(`/tasks/${taskId}/comments`, "POST", { author, body });
    return { content: [{ type: "text" as const, text: `Comment added to task ${taskId}` }] };
  },
);

// ─── Project Tools ───

server.tool(
  "project_list",
  "List all projects.",
  {},
  async () => {
    const projects = await apiCall("/projects");
    const summary = Array.isArray(projects)
      ? projects.map((p: { name: string; slug: string; id: string }) =>
          `- ${p.name} (${p.slug}) id:${p.id}`
        ).join("\n")
      : JSON.stringify(projects);

    return { content: [{ type: "text" as const, text: summary || "No projects" }] };
  },
);

server.tool(
  "project_create",
  "Create a new project.",
  {
    name: z.string().describe("Project name"),
    repoUrl: z.string().optional().describe("Git repository URL"),
    description: z.string().optional().describe("Project description"),
  },
  async (params) => {
    const project = await apiCall("/projects", "POST", params);
    return { content: [{ type: "text" as const, text: `Project created: ${project.name} (id: ${project.id})` }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
