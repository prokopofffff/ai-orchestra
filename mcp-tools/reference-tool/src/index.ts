import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * MCP server for cross-project read access. Backs Phase 2 of the
 * cross-project-context plan: the model talks to this server, the server
 * relays to orchestra-core's /api/references/* endpoints, which enforce:
 *   - the caller is the project's owner/member (JWT)
 *   - the requested ref project ID is in the caller's settings.referenceProjects
 *   - the caller still has read access to the ref project (handles revocation)
 *   - the requested path canonicalizes inside the ref project's local_path
 *
 * The MCP server itself never touches the filesystem — all reads go via
 * HTTP so authorization stays in one place (orchestra-core).
 */

const ORCHESTRA_URL = process.env.ORCHESTRA_URL ?? "http://127.0.0.1:3000";
const PROJECT_ID = process.env.AGENT_PROJECT_ID ?? "";
const ORCHESTRA_JWT = process.env.ORCHESTRA_JWT ?? "";

const server = new McpServer({
  name: "orchestra-reference",
  version: "0.1.0",
});

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(ORCHESTRA_JWT ? { Authorization: `Bearer ${ORCHESTRA_JWT}` } : {}),
  };
}

function withCaller(qs: URLSearchParams): URLSearchParams {
  qs.set("callerProjectId", PROJECT_ID);
  return qs;
}

async function callApi(pathAndQuery: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${ORCHESTRA_URL}/api${pathAndQuery}`, {
    method: "GET",
    headers: authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function asTextResult(value: unknown, isError = false): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return isError
    ? { content: [{ type: "text" as const, text }], isError: true }
    : { content: [{ type: "text" as const, text }] };
}

server.tool(
  "list_reference_projects",
  "List the other projects this project may read for context (configured in Settings → Референс-проекты). " +
    "Returns id, slug, name, description, and absolutePath for each. Use the id to call other reference_* tools.",
  {},
  async () => {
    const qs = withCaller(new URLSearchParams());
    const { ok, status, data } = await callApi(`/references/projects?${qs.toString()}`);
    if (!ok) return asTextResult(`Error ${status}: ${(data as { error?: string }).error ?? "unknown"}`, true);
    return asTextResult(data);
  },
);

server.tool(
  "list_reference_files",
  "List files and subdirectories inside a referenced project. Capped at 500 entries; if more " +
    "exist the response includes `truncated: true` — narrow with `path` or `glob` and call again.",
  {
    refProjectId: z.string().uuid()
      .describe("ID of the reference project (from list_reference_projects)"),
    path: z.string().optional()
      .describe("Subdirectory relative to the project root. Empty / omitted = root."),
    glob: z.string().optional()
      .describe("Optional shell-style glob filter, e.g. \"*.ts\" or \"src/**/*.tsx\"."),
  },
  async ({ refProjectId, path, glob }) => {
    const qs = withCaller(new URLSearchParams());
    if (path) qs.set("path", path);
    if (glob) qs.set("glob", glob);
    const { ok, status, data } = await callApi(`/references/${refProjectId}/files?${qs.toString()}`);
    if (!ok) return asTextResult(`Error ${status}: ${(data as { error?: string }).error ?? "unknown"}`, true);
    return asTextResult(data);
  },
);

server.tool(
  "read_reference_file",
  "Read a file from a referenced project. Content is capped at 50KB; if larger the response " +
    "includes `truncated: true` and `nextOffset` — call again with `offset` to continue.",
  {
    refProjectId: z.string().uuid()
      .describe("ID of the reference project (from list_reference_projects)"),
    path: z.string()
      .describe("File path relative to the project root, e.g. \"src/auth.ts\"."),
    offset: z.number().int().nonnegative().optional()
      .describe("Byte offset to start reading from. Omit for the start of the file."),
  },
  async ({ refProjectId, path, offset }) => {
    const qs = withCaller(new URLSearchParams());
    qs.set("path", path);
    if (offset !== undefined) qs.set("offset", String(offset));
    const { ok, status, data } = await callApi(`/references/${refProjectId}/file?${qs.toString()}`);
    if (!ok) return asTextResult(`Error ${status}: ${(data as { error?: string }).error ?? "unknown"}`, true);
    return asTextResult(data);
  },
);

server.tool(
  "grep_reference",
  "Search for a regex/literal inside a referenced project. Returns matches as " +
    "{ path, line, snippet } objects, capped at 100. Narrow with `path` to restrict to a subdir.",
  {
    refProjectId: z.string().uuid()
      .describe("ID of the reference project (from list_reference_projects)"),
    query: z.string().min(1)
      .describe("Substring or ECMAScript regex to search for (case-insensitive)."),
    path: z.string().optional()
      .describe("Subdirectory to restrict the search to. Empty / omitted = whole project."),
  },
  async ({ refProjectId, query, path }) => {
    const qs = withCaller(new URLSearchParams());
    qs.set("q", query);
    if (path) qs.set("path", path);
    const { ok, status, data } = await callApi(`/references/${refProjectId}/grep?${qs.toString()}`);
    if (!ok) return asTextResult(`Error ${status}: ${(data as { error?: string }).error ?? "unknown"}`, true);
    return asTextResult(data);
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("reference-tool fatal:", err);
  process.exit(1);
});
