import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ORCHESTRA_URL = process.env.ORCHESTRA_URL || "http://localhost:3000";

async function apiFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${ORCHESTRA_URL}/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  return response.json();
}

const server = new McpServer({
  name: "task-tool",
  version: "0.1.0",
});

// Create task
server.tool(
  "task_create",
  "Create a new task (Epic, Task, Subtask, Bug, Feature) in the project.",
  {
    project_id: z.string().describe("The project ID"),
    subject: z.string().describe("Task title"),
    description: z.string().optional().describe("Task description in markdown"),
    type: z
      .enum(["Epic", "Task", "Subtask", "Bug", "Feature"])
      .default("Task")
      .describe("Task type"),
    priority: z
      .enum(["Low", "Normal", "High", "Immediate"])
      .default("Normal")
      .describe("Priority level"),
    parent_id: z.string().optional().describe("Parent task ID for subtasks"),
    assignee: z.string().optional().describe("Assignee role or name"),
  },
  async ({ project_id, subject, description, type, priority, parent_id, assignee }) => {
    const data = (await apiFetch("/tasks", {
      method: "POST",
      body: JSON.stringify({
        projectId: project_id,
        subject,
        description,
        type,
        priority,
        parentId: parent_id,
        assignee,
      }),
    })) as { id: string; subject: string };

    return {
      content: [
        {
          type: "text" as const,
          text: `Task created: #${data.id.substring(0, 8)} - ${data.subject}`,
        },
      ],
    };
  }
);

// Update task
server.tool(
  "task_update",
  "Update an existing task.",
  {
    task_id: z.string().describe("Task ID"),
    subject: z.string().optional().describe("New title"),
    description: z.string().optional().describe("New description"),
    state: z
      .enum([
        "new", "described", "designing", "design_ready",
        "in_development", "pr_created", "in_testing", "tested",
        "in_review", "approved", "merged", "closed", "rejected",
      ])
      .optional()
      .describe("New state"),
    priority: z.enum(["Low", "Normal", "High", "Immediate"]).optional(),
    assignee: z.string().optional().describe("Assignee role or name"),
    done_ratio: z.number().min(0).max(100).optional().describe("Percentage done"),
  },
  async ({ task_id, subject, description, state, priority, assignee, done_ratio }) => {
    const body: Record<string, unknown> = {};
    if (subject !== undefined) body.subject = subject;
    if (description !== undefined) body.description = description;
    if (state !== undefined) body.state = state;
    if (priority !== undefined) body.priority = priority;
    if (assignee !== undefined) body.assignee = assignee;
    if (done_ratio !== undefined) body.doneRatio = done_ratio;

    const data = (await apiFetch(`/tasks/${task_id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    })) as { id: string; subject: string; state: string };

    return {
      content: [
        {
          type: "text" as const,
          text: `Task updated: #${data.id.substring(0, 8)} - ${data.subject} [${data.state}]`,
        },
      ],
    };
  }
);

// Get task
server.tool(
  "task_get",
  "Get details of a specific task.",
  {
    task_id: z.string().describe("Task ID"),
  },
  async ({ task_id }) => {
    const data = await apiFetch(`/tasks/${task_id}`);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

// List tasks
server.tool(
  "task_list",
  "List tasks for a project, optionally filtered by state.",
  {
    project_id: z.string().describe("The project ID"),
    state: z.string().optional().describe("Filter by state"),
  },
  async ({ project_id, state }) => {
    let path = `/tasks?project=${project_id}`;
    if (state) path += `&state=${state}`;

    const data = await apiFetch(path);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

// Add comment
server.tool(
  "task_add_comment",
  "Add a comment to a task.",
  {
    task_id: z.string().describe("Task ID"),
    comment: z.string().describe("Comment text"),
  },
  async ({ task_id, comment }) => {
    const author = process.env.AGENT_ROLE || "unknown";

    await apiFetch(`/tasks/${task_id}/comments`, {
      method: "POST",
      body: JSON.stringify({ author, comment }),
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Comment added to task #${task_id.substring(0, 8)}`,
        },
      ],
    };
  }
);

// Create project
server.tool(
  "project_create",
  "Create a new project.",
  {
    name: z.string().describe("Project name"),
    description: z.string().optional().describe("Project description"),
  },
  async ({ name, description }) => {
    const data = (await apiFetch("/projects", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    })) as { id: string; name: string };

    return {
      content: [
        {
          type: "text" as const,
          text: `Project created: ${data.name} (ID: ${data.id})`,
        },
      ],
    };
  }
);

// List projects
server.tool(
  "project_list",
  "List all projects.",
  {},
  async () => {
    const data = await apiFetch("/projects");
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
