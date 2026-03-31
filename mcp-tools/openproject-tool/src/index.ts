import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const OPENPROJECT_URL =
  process.env.OPENPROJECT_URL || "http://localhost:8080";
const OPENPROJECT_API_KEY = process.env.OPENPROJECT_API_KEY || "";

const AUTH_HEADER = `Basic ${Buffer.from(`apikey:${OPENPROJECT_API_KEY}`).toString("base64")}`;

// --- API helpers ---

async function opFetch(path: string, options: RequestInit = {}): Promise<unknown> {
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

  return response.json();
}

interface NamedResource {
  id: number;
  name: string;
  identifier?: string;
  subject?: string;
  percentageDone?: number;
  createdAt?: string;
  updatedAt?: string;
  lockVersion?: number;
  description?: { raw: string };
  _links?: {
    self?: { href: string };
    status?: { title: string };
    type?: { title: string };
    priority?: { title: string };
  };
}

interface CollectionResponse {
  _embedded?: {
    elements: NamedResource[];
  };
}

// --- ID resolution cache ---

const cache = new Map<string, Map<string, number>>();

async function resolveId(
  resource: "types" | "statuses" | "priorities",
  name: string
): Promise<number> {
  let resourceCache = cache.get(resource);

  if (!resourceCache) {
    const data = (await opFetch(`/${resource}`)) as CollectionResponse;
    const elements = data._embedded?.elements || [];
    resourceCache = new Map<string, number>();
    for (const el of elements) {
      resourceCache.set(el.name.toLowerCase(), el.id);
    }
    cache.set(resource, resourceCache);
  }

  const id = resourceCache.get(name.toLowerCase());
  if (id === undefined) {
    const available = Array.from(resourceCache.keys()).join(", ");
    throw new Error(
      `Unknown ${resource} "${name}". Available: ${available}`
    );
  }

  return id;
}

function resourceHref(
  resource: "types" | "statuses" | "priorities" | "work_packages" | "projects",
  id: number
): string {
  return `/api/v3/${resource}/${id}`;
}

// --- MCP Server ---

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
    const data = (await opFetch("/projects")) as CollectionResponse;
    const projects = (data._embedded?.elements || []).map((p) => ({
      id: p.id,
      name: p.name,
      identifier: p.identifier,
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
    const typeId = await resolveId("types", type);
    const priorityId = await resolveId("priorities", priority);

    const body: Record<string, unknown> = {
      subject,
      description: description
        ? { format: "markdown", raw: description }
        : undefined,
      _links: {
        type: { href: resourceHref("types", typeId) },
        priority: { href: resourceHref("priorities", priorityId) },
        ...(parent_id
          ? { parent: { href: resourceHref("work_packages", parent_id) } }
          : {}),
      },
    };

    const data = (await opFetch(`/projects/${project_id}/work_packages`, {
      method: "POST",
      body: JSON.stringify(body),
    })) as NamedResource;

    return {
      content: [
        {
          type: "text" as const,
          text: `Task created: #${data.id} - ${data.subject || data.name}\nURL: ${OPENPROJECT_URL}/work_packages/${data.id}`,
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
    // Get current lock version (required for PATCH)
    const current = (await opFetch(`/work_packages/${task_id}`)) as NamedResource;

    const links: Record<string, { href: string }> = {};
    if (status) {
      const statusId = await resolveId("statuses", status);
      links.status = { href: resourceHref("statuses", statusId) };
    }

    const body: Record<string, unknown> = {
      lockVersion: current.lockVersion,
      ...(subject ? { subject } : {}),
      ...(description
        ? { description: { format: "markdown", raw: description } }
        : {}),
      ...(done_ratio !== undefined ? { percentageDone: done_ratio } : {}),
      ...(Object.keys(links).length > 0 ? { _links: links } : {}),
    };

    const data = (await opFetch(`/work_packages/${task_id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    })) as NamedResource;

    return {
      content: [
        {
          type: "text" as const,
          text: `Task updated: #${data.id} - ${data.subject || data.name}`,
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
    const data = (await opFetch(`/work_packages/${task_id}`)) as NamedResource;

    const task = {
      id: data.id,
      subject: data.subject || data.name,
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
      const statusId = await resolveId("statuses", status);
      path += `&filters=[{"status":{"operator":"=","values":["${statusId}"]}}]`;
    }

    const data = (await opFetch(path)) as CollectionResponse;

    const tasks = (data._embedded?.elements || []).map((wp) => ({
      id: wp.id,
      subject: wp.subject || wp.name,
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
