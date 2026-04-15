import { describe, it, expect } from "vitest";
import { checkSessionHealth } from "../heartbeat";
import type { Session } from "../session-manager";

const STALE_MS = 10 * 60_000;       // matches heartbeat.ts STALE_THRESHOLD_MS
const TL_MAX_MS = 8 * 60 * 60_000;  // matches TECH_LEAD_MAX_AGE_MS

function session(overrides: Partial<Session>): Session {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    projectId: "00000000-0000-0000-0000-000000000002",
    role: "backend",
    taskId: null,
    claudeSessionId: null,
    status: "running",
    model: "sonnet",
    worktreePath: null,
    lastHeartbeat: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    ...overrides,
  };
}

describe("heartbeat — checkSessionHealth", () => {
  it("returns healthy when heartbeat is fresh", () => {
    const h = checkSessionHealth(session({ lastHeartbeat: new Date(Date.now() - 30_000) }));
    expect(h.status).toBe("healthy");
  });

  it("returns healthy when lastHeartbeat is null (no heartbeat yet — session just started)", () => {
    const h = checkSessionHealth(session({ lastHeartbeat: null }));
    expect(h.status).toBe("healthy");
  });

  it("returns hung when heartbeat is stale (> 10 min)", () => {
    const h = checkSessionHealth(session({ lastHeartbeat: new Date(Date.now() - STALE_MS - 1_000) }));
    expect(h.status).toBe("hung");
    expect(h.reason).toMatch(/No heartbeat for \d+m/);
  });

  it("returns hung for tech-lead sessions older than 8h (context-overflow guard)", () => {
    const h = checkSessionHealth(session({
      role: "tech-lead",
      startedAt: new Date(Date.now() - TL_MAX_MS - 1_000),
      // fresh heartbeat so only the age check trips
      lastHeartbeat: new Date(),
    }));
    expect(h.status).toBe("hung");
    expect(h.reason).toMatch(/Tech Lead session exceeded 8h/);
  });

  it("stale-heartbeat check takes precedence over age check", () => {
    const h = checkSessionHealth(session({
      role: "tech-lead",
      startedAt: new Date(Date.now() - TL_MAX_MS - 1_000),
      lastHeartbeat: new Date(Date.now() - STALE_MS - 1_000),
    }));
    expect(h.status).toBe("hung");
    expect(h.reason).toMatch(/No heartbeat/);
  });

  it("non-TL sessions are not subject to the 8h age cap", () => {
    const h = checkSessionHealth(session({
      role: "backend",
      startedAt: new Date(Date.now() - TL_MAX_MS - 1_000),
      lastHeartbeat: new Date(),
    }));
    expect(h.status).toBe("healthy");
  });

  it("attaches sessionId and role to every result", () => {
    const s = session({ id: "abc", role: "qa" });
    const h = checkSessionHealth(s);
    expect(h.sessionId).toBe("abc");
    expect(h.role).toBe("qa");
  });
});
