import { describe, it, expect } from "vitest";
import { getUsage } from "../usage-tracker";

describe("usage-tracker", () => {
  it("returns usage info shape", () => {
    const usage = getUsage();
    expect(usage).toHaveProperty("sessions");
    expect(usage).toHaveProperty("byRole");
    expect(usage).toHaveProperty("byModel");
    expect(usage).toHaveProperty("lastChecked");
    expect(usage.sessions).toHaveProperty("total");
    expect(usage.sessions).toHaveProperty("running");
    expect(usage.sessions).toHaveProperty("completed");
    expect(usage.sessions).toHaveProperty("crashed");
  });

  it("initial state has zero counts", () => {
    const usage = getUsage();
    expect(usage.sessions.total).toBe(0);
    expect(usage.sessions.running).toBe(0);
    expect(Object.keys(usage.byRole)).toHaveLength(0);
  });
});
