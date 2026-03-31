import type { AgentSession, AuditEntry, QueuedTask, HealthStatus } from "./types";

const BASE = "/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  sessions: () => get<AgentSession[]>("/sessions"),
  audit: (limit = 50) => get<AuditEntry[]>(`/flow/audit?limit=${limit}`),
  violations: (limit = 50) => get<AuditEntry[]>(`/flow/violations?limit=${limit}`),
  queue: () => get<QueuedTask[]>("/queue"),
  health: () => get<HealthStatus>("/health"),
};
