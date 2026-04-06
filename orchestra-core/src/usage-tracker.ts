import { getPool } from "./db";
import { exec } from "./repo-manager";

export interface UsageInfo {
  sessions: {
    total: number;
    running: number;
    completed: number;
    crashed: number;
  };
  byRole: Record<string, { sessions: number; running: number }>;
  byModel: Record<string, number>;
  lastChecked: string;
}

let cachedUsage: UsageInfo = {
  sessions: { total: 0, running: 0, completed: 0, crashed: 0 },
  byRole: {},
  byModel: {},
  lastChecked: new Date().toISOString(),
};

let intervalId: ReturnType<typeof setInterval> | null = null;
const CHECK_INTERVAL_MS = 30_000;

export function startUsageTracking(): void {
  if (intervalId) return;
  refreshUsage();
  intervalId = setInterval(refreshUsage, CHECK_INTERVAL_MS);
  console.log("Usage tracking started (every 30s)");
}

export function stopUsageTracking(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export function getUsage(): UsageInfo {
  return { ...cachedUsage };
}

async function refreshUsage(): Promise<void> {
  try {
    const pool = getPool();

    // Session counts
    const { rows: statusRows } = await pool.query(
      `SELECT status, COUNT(*)::int as count FROM sessions GROUP BY status`,
    );
    const statusCounts: Record<string, number> = {};
    for (const r of statusRows) statusCounts[r.status as string] = r.count as number;

    // By role
    const { rows: roleRows } = await pool.query(
      `SELECT role, status, COUNT(*)::int as count FROM sessions GROUP BY role, status`,
    );
    const byRole: Record<string, { sessions: number; running: number }> = {};
    for (const r of roleRows) {
      const role = r.role as string;
      if (!byRole[role]) byRole[role] = { sessions: 0, running: 0 };
      byRole[role].sessions += r.count as number;
      if (r.status === "running") byRole[role].running = r.count as number;
    }

    // By model
    const { rows: modelRows } = await pool.query(
      `SELECT model, COUNT(*)::int as count FROM sessions GROUP BY model`,
    );
    const byModel: Record<string, number> = {};
    for (const r of modelRows) byModel[r.model as string] = r.count as number;

    cachedUsage = {
      sessions: {
        total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
        running: statusCounts.running ?? 0,
        completed: (statusCounts.terminated ?? 0),
        crashed: statusCounts.crashed ?? 0,
      },
      byRole,
      byModel,
      lastChecked: new Date().toISOString(),
    };
  } catch {
    cachedUsage.lastChecked = new Date().toISOString();
  }
}
