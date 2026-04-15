import { describe, it, expect } from "vitest";
import {
  canCreateTask,
  canUpdateTask,
  canDeleteTask,
  validateSignalSender,
} from "../agent-auth";

describe("agent-auth — canCreateTask", () => {
  it("allows tech-lead to create tasks", () => {
    expect(canCreateTask("tech-lead")).toEqual({ allowed: true });
  });

  it.each(["designer", "frontend", "backend", "qa", "devops"] as const)(
    "rejects %s (non-TL) from creating tasks",
    (role) => {
      const res = canCreateTask(role);
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/cannot create tasks/);
    },
  );
});

describe("agent-auth — canDeleteTask", () => {
  it("allows tech-lead to delete", () => {
    expect(canDeleteTask("tech-lead")).toEqual({ allowed: true });
  });

  it.each(["designer", "frontend", "backend", "qa", "devops"] as const)(
    "rejects %s from deleting",
    (role) => {
      expect(canDeleteTask(role).allowed).toBe(false);
    },
  );
});

describe("agent-auth — canUpdateTask", () => {
  it("tech-lead can update any task, any state", () => {
    expect(canUpdateTask("tech-lead", "backend", { state: "approved" })).toEqual({ allowed: true });
    expect(canUpdateTask("tech-lead", null, { state: "merged" })).toEqual({ allowed: true });
  });

  it("non-TL can only update tasks assigned to themselves", () => {
    expect(canUpdateTask("backend", "backend", {}).allowed).toBe(true);
    const wrongOwner = canUpdateTask("backend", "frontend", {});
    expect(wrongOwner.allowed).toBe(false);
    expect(wrongOwner.reason).toMatch(/can only update tasks assigned to backend/);
  });

  it("non-TL can set states in their allowlist", () => {
    expect(canUpdateTask("backend", "backend", { state: "pr_created" }).allowed).toBe(true);
    expect(canUpdateTask("qa", "qa", { state: "tested" }).allowed).toBe(true);
  });

  it("non-TL cannot set states outside their allowlist", () => {
    const res = canUpdateTask("backend", "backend", { state: "approved" });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/cannot set state to approved/);
  });

  it("rejects unknown role", () => {
    const res = canUpdateTask("hacker" as never, "hacker", {});
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/Unknown role/);
  });
});

describe("agent-auth — validateSignalSender", () => {
  it("allows when no actual role is provided (user / system)", () => {
    expect(validateSignalSender("tech-lead", undefined)).toEqual({ allowed: true });
  });

  it("allows when claim matches actual", () => {
    expect(validateSignalSender("backend", "backend")).toEqual({ allowed: true });
  });

  it("rejects when claim ≠ actual (impersonation attempt)", () => {
    const res = validateSignalSender("tech-lead", "backend");
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/Role mismatch/);
    expect(res.reason).toContain("tech-lead");
    expect(res.reason).toContain("backend");
  });
});
