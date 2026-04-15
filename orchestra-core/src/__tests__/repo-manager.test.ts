import { describe, it, expect } from "vitest";
import { branchName, workspacePath, getWorkspacesRoot } from "../repo-manager";

describe("repo-manager — branchName", () => {
  it("uses the role's conventional prefix", () => {
    expect(branchName("tech-lead", "42")).toBe("chore/42");
    expect(branchName("designer",  "42")).toBe("design/42");
    expect(branchName("frontend",  "42")).toBe("feature/frontend/42");
    expect(branchName("backend",   "42")).toBe("feature/backend/42");
    expect(branchName("qa",        "42")).toBe("test/42");
    expect(branchName("devops",    "42")).toBe("ci/42");
  });

  it("falls back to 'work/' for unknown roles", () => {
    expect(branchName("hacker", "42")).toBe("work/42");
  });

  it("preserves the task id verbatim (uuid, etc.)", () => {
    const taskId = "a1b2c3d4-e5f6-7890-1234-567890abcdef";
    expect(branchName("backend", taskId)).toBe(`feature/backend/${taskId}`);
  });
});

describe("repo-manager — workspacePath", () => {
  it("composes the workspaces root with the project slug", () => {
    const root = getWorkspacesRoot();
    expect(workspacePath("my-proj")).toBe(`${root}/my-proj`);
  });

  it("isolates projects from each other", () => {
    expect(workspacePath("a")).not.toBe(workspacePath("b"));
  });
});
