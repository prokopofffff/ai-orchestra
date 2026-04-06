import { describe, it, expect } from "vitest";
import { getUsage } from "../usage-tracker";

describe("usage-tracker", () => {
  it("returns usage info shape", () => {
    const usage = getUsage();
    expect(usage).toHaveProperty("percent");
    expect(usage).toHaveProperty("status");
    expect(usage).toHaveProperty("lastChecked");
    expect(usage).toHaveProperty("raw");
    expect(["ok", "warning", "critical", "unknown"]).toContain(usage.status);
  });

  it("initial status is unknown", () => {
    const usage = getUsage();
    expect(usage.status).toBe("unknown");
    expect(usage.percent).toBeNull();
  });
});
