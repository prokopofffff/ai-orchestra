import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * MCP server exposing per-project preview-contour controls. Only the
 * tech-lead role gets it (wired up in orchestra-core/src/mcp-config-generator.ts).
 *
 * The tools wrap the preview HTTP API. All routes hard-bind the agent
 * to its own project via AGENT_PROJECT_ID — the tools intentionally do
 * not accept a projectId parameter, so the tech-lead can't be tricked
 * (or prompted) into reaching into another tenant's preview.
 *
 * `internalUrl` returned by preview_deploy / preview_status is the
 * orchestra-core-internal DNS for the per-project DinD-hosted app
 * (http://preview-dind-<id>:<port>). curl from inside the orchestra-core
 * container resolves it; the public URL goes through the JWT-gated
 * reverse proxy (v1.7) and is for humans.
 */

const ORCHESTRA_URL = process.env.ORCHESTRA_URL ?? "http://localhost:3000";
const AGENT_ROLE = process.env.AGENT_ROLE ?? "";
const PROJECT_ID = process.env.AGENT_PROJECT_ID ?? "";
const ORCHESTRA_JWT = process.env.ORCHESTRA_JWT ?? "";

const server = new McpServer({ name: "orchestra-preview", version: "0.1.0" });

class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(typeof body === "object" && body && "error" in body
      ? String((body as { error: unknown }).error)
      : `HTTP ${status}`);
  }
}

async function apiCall<T = unknown>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${ORCHESTRA_URL}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Role": AGENT_ROLE,
      ...(ORCHESTRA_JWT ? { "Authorization": `Bearer ${ORCHESTRA_JWT}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

function errorResult(err: unknown) {
  const msg = err instanceof ApiError
    ? `${err.status} ${err.message}`
    : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

function internalUrl(port: number): string {
  return `http://preview-dind-${PROJECT_ID}:${port}`;
}

interface PreviewStatus {
  enabled: boolean;
  state: string;
  appPort: number;
  branch: string;
  currentCommit: string | null;
  lastDeployedAt: string | null;
  errorMessage: string | null;
}

server.tool(
  "preview_status",
  "Get the current state of the project's preview contour. Returns " +
    "enabled flag, state (stopped|building|running|sleeping|error), " +
    "current deployed commit, app port, and the internal URL the agent " +
    "can curl from inside the orchestra-core network.",
  {},
  async () => {
    try {
      const s = await apiCall<PreviewStatus>(`/projects/${PROJECT_ID}/preview`);
      const lines = [
        `state: ${s.state}`,
        `enabled: ${s.enabled}`,
        `branch: ${s.branch}`,
        `currentCommit: ${s.currentCommit ?? "(none)"}`,
        `appPort: ${s.appPort}`,
        `internalUrl: ${internalUrl(s.appPort)}`,
        `lastDeployedAt: ${s.lastDeployedAt ?? "(never)"}`,
      ];
      if (s.errorMessage) lines.push(`errorMessage: ${s.errorMessage}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) { return errorResult(err); }
  },
);

server.tool(
  "preview_deploy",
  "Pull the configured branch (or `branch` override), build the docker " +
    "image inside the project's preview contour, restart the app container, " +
    "and block until it responds to HTTP. Returns the internal URL and " +
    "deployed commit on success. Blocks up to 60s.",
  {
    branch: z.string().optional().describe(
      "Override the configured branch for this deploy. Omit to use the " +
        "branch saved in Settings → Preview.",
    ),
  },
  async ({ branch }) => {
    try {
      await apiCall(`/projects/${PROJECT_ID}/preview/deploy`, "POST", branch ? { branch } : undefined);
      const s = await apiCall<PreviewStatus>(`/projects/${PROJECT_ID}/preview`);
      return {
        content: [{
          type: "text" as const,
          text: [
            `state: ${s.state}`,
            `currentCommit: ${s.currentCommit ?? "(unknown)"}`,
            `internalUrl: ${internalUrl(s.appPort)}`,
            "",
            `Hit the internal URL with curl from this same container, e.g.:`,
            `  curl ${internalUrl(s.appPort)}/`,
          ].join("\n"),
        }],
      };
    } catch (err) { return errorResult(err); }
  },
);

server.tool(
  "preview_logs",
  "Tail the project's preview app container logs. Returns up to `tail` " +
    "lines (default 200, max 5000) of stdout+stderr. Useful right after " +
    "a curl request that returned an unexpected response.",
  {
    tail: z.number().int().min(1).max(5000).optional().describe(
      "How many recent lines to return. Default 200.",
    ),
  },
  async ({ tail }) => {
    try {
      const qs = tail ? `?tail=${tail}` : "";
      const data = await apiCall<{ lines: string[] }>(`/projects/${PROJECT_ID}/preview/logs${qs}`);
      const lines = data.lines.length === 0
        ? "(no log lines — app container may not be running)"
        : data.lines.join("\n");
      return { content: [{ type: "text" as const, text: lines }] };
    } catch (err) { return errorResult(err); }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
