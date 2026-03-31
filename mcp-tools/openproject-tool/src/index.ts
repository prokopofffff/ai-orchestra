import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const OPENPROJECT_URL =
  process.env.OPENPROJECT_URL || "http://localhost:8080";
const OPENPROJECT_API_KEY = process.env.OPENPROJECT_API_KEY || "";

const AUTH_HEADER = `Basic ${Buffer.from(`apikey:${OPENPROJECT_API_KEY}`).toString("base64")}`;

interface OpenProjectResponse {
  id: number;
  name?: string;
  identifier?: string;
  subject?: string;
  description?: { raw: string };
  lockVersion?: number;
  percentageDone?: number;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
  _links?: {
    status?: { title: string; href: string };
    type?: { title: string; href: string };
    priority?: { title: string; href: string };
  };
  _embedded?: {
    elements: OpenProjectResponse[];
  };
}

async function opFetch(
  path: string,
  options: RequestInit = {}
): Promise<OpenProjectResponse> {
  const response = await fetch(`${OPENPROJECT_URL}/api/v3${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH_HEADER,
      ...(options.headers as Record<string, string>),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenProject API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<OpenProjectResponse>;
}

const server = new McpServer({
  name: "openproject-tool",
  version: "0.1.0",
});

// List projects
server.tool(
  "openproject_list_projects",
  "List all projects in OpenProject.",
  {},
  async () => {
    const data = await opFetch("/projects");
    const projects = (data._embedded?.elements || []).map((p) => ({
      id: p.id,
      name: p.name,
      identifier: p.identifier,
      status: p.status,
    }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify(projects, null, 2) }],
    };
  }
);

// Create work package (task)
server.tool(
  "openproject_create_task",
  "Create a new task (work package) in OpenProject.",
  {
    project_id: z.string().describe("The project identifier"),
    subject: z.string().describe("Task title"),
    description: z
      .string()
      .optional()
      .describe("Task description in markdown"),
    type: z
      .enum(["Epic", "Task", "Subtask", "Bug", "Feature"])
      .default("Task")
      .describe("Work package type"),
    parent_id: z
      .number()
      .optional()
      .describe("Parent work package ID for subtasks"),
    priority: z
      .enum(["Low", "Normal", "High", "Immediate"])
      .default("Normal")
      .describe("Priority level"),
  },
  async ({ project_id, subject, description, type, parent_id, priority }) => {
    const body = {
      subject,
      description: description
        ? { format: "markdown", raw: description }
        : undefined,
      _links: {
        type: { href: `/api/v3/types?name=${type}`, title: type },
        priority: {
          href: `/api/v3/priorities?name=${priority}`,
          title: priority,
        },
        ...(parent_id
          ? { parent: { href: `/api/v3/work_packages/${parent_id}` } }
          : {}),
      },
    };

    const data = await opFetch(`/projects/${project_id}/work_packages`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Task created: #${data.id} - ${data.subject}\nURL: ${OPENPROJECT_URL}/work_packages/${data.id}`,
        },
      ],
    };
  }
);

// Update work package
server.tool(
  "openproject_update_task",
  "Update an existing task (work package) in OpenProject.",
  {
    task_id: z.number().describe("Work package ID"),
    subject: z.string().optional().describe("New task title"),
    description: z
      .string()
      .optional()
      .describe("New task description in markdown"),
    status: z
      .enum([
        "New",
        "In progress",
        "Developed",
        "In testing",
        "Tested",
        "Closed",
        "Rejected",
      ])
      .optional()
      .describe("New status"),
    done_ratio: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("Percentage done"),
  },
  async ({ task_id, subject, description, status, done_ratio }) => {
    const current = await opFetch(`/work_packages/${task_id}`);

    const body = {
      lockVersion: current.lockVersion,
      ...(subject ? { subject } : {}),
      ...(description
        ? { description: { format: "markdown", raw: description } }
        : {}),
      ...(done_ratio !== undefined ? { percentageDone: done_ratio } : {}),
      ...(status
        ? {
            _links: {
              status: {
                href: `/api/v3/statuses?name=${status}`,
                title: status,
              },
            },
          }
        : {}),
    };

    const data = await opFetch(`/work_packages/${task_id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Task updated: #${data.id} - ${data.subject}`,
        },
      ],
    };
  }
);

// Get work package details
server.tool(
  "openproject_get_task",
  "Get details of a specific task (work package).",
  {
    task_id: z.number().describe("Work package ID"),
  },
  async ({ task_id }) => {
    const data = await opFetch(`/work_packages/${task_id}`);

    const task = {
      id: data.id,
      subject: data.subject,
      description: data.description?.raw || "",
      status: data._links?.status?.title || "Unknown",
      type: data._links?.type?.title || "Unknown",
      priority: data._links?.priority?.title || "Normal",
      percentageDone: data.percentageDone || 0,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
    };
  }
);

// List work packages for a project
server.tool(
  "openproject_list_tasks",
  "List tasks (work packages) for a project, optionally filtered by status.",
  {
    project_id: z.string().describe("The project identifier"),
    status: z.string().optional().describe("Filter by status name"),
  },
  async ({ project_id, status }) => {
    let path = `/projects/${project_id}/work_packages?pageSize=50`;
    if (status) {
      path += `&filters=[{"status":{"operator":"=","values":["${status}"]}}]`;
    }

    const data = await opFetch(path);
    const tasks = (data._embedded?.elements || []).map((wp) => ({
      id: wp.id,
      subject: wp.subject,
      status: wp._links?.status?.title || "Unknown",
      type: wp._links?.type?.title || "Unknown",
      percentageDone: wp.percentageDone || 0,
    }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify(tasks, null, 2) }],
    };
  }
);

// Add comment to work package
server.tool(
  "openproject_add_comment",
  "Add a comment to a task (work package).",
  {
    task_id: z.number().describe("Work package ID"),
    comment: z.string().describe("Comment text in markdown"),
  },
  async ({ task_id, comment }) => {
    await opFetch(`/work_packages/${task_id}/activities`, {
      method: "POST",
      body: JSON.stringify({
        comment: { format: "markdown", raw: comment },
      }),
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Comment added to task #${task_id}`,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
