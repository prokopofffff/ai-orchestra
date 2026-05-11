import { describe, it, expect } from "vitest";
import { buildCanUseTool, extractText } from "../agents/sdk-runner";

describe("sdk-runner — buildCanUseTool", () => {
  it("returns undefined when no deny patterns are configured", () => {
    expect(buildCanUseTool([])).toBeUndefined();
  });

  it("allows non-edit tools regardless of path", async () => {
    const guard = buildCanUseTool(["src/backend/**"])!;
    const result = await guard("Read", { file_path: "src/backend/api.ts" }, {} as never);
    expect(result.behavior).toBe("allow");
  });

  it("allows Edit when file_path is missing (can't enforce without it)", async () => {
    const guard = buildCanUseTool(["src/backend/**"])!;
    const result = await guard("Edit", {}, {} as never);
    expect(result.behavior).toBe("allow");
  });

  it("denies Edit on a path matching a denied glob", async () => {
    const guard = buildCanUseTool(["src/backend/**"])!;
    const result = await guard("Edit", { file_path: "src/backend/users.ts" }, {} as never);
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toMatch(/outside this role's scope/);
      expect(result.message).toContain("src/backend/users.ts");
    }
  });

  it("denies Write and MultiEdit the same way as Edit", async () => {
    const guard = buildCanUseTool(["src/frontend/**"])!;
    const a = await guard("Write", { file_path: "src/frontend/page.tsx" }, {} as never);
    const b = await guard("MultiEdit", { file_path: "src/frontend/comp.tsx" }, {} as never);
    expect(a.behavior).toBe("deny");
    expect(b.behavior).toBe("deny");
  });

  it("matches relative paths via the leading-** fallback", async () => {
    const guard = buildCanUseTool(["secrets.env"])!;
    const result = await guard("Edit", { file_path: "/abs/path/to/secrets.env" }, {} as never);
    expect(result.behavior).toBe("deny");
  });

  it("allows Edit on a path that matches no deny pattern", async () => {
    const guard = buildCanUseTool(["src/backend/**", "*.env"])!;
    const result = await guard("Edit", { file_path: "src/frontend/Header.tsx" }, {} as never);
    expect(result.behavior).toBe("allow");
  });

  it("toolsDeny: exact-name matcher blocks the tool regardless of args", async () => {
    const guard = buildCanUseTool([], ["Edit"])!;
    const result = await guard("Edit", { file_path: "anywhere.ts" }, {} as never);
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") expect(result.message).toMatch(/not available to this role/);
  });

  it("toolsDeny: prefix wildcard matches MCP-style names", async () => {
    const guard = buildCanUseTool([], ["mcp__pencil__*"])!;
    const r1 = await guard("mcp__pencil__batch_design", {}, {} as never);
    const r2 = await guard("mcp__pencil__get_editor_state", {}, {} as never);
    const r3 = await guard("mcp__other__tool", {}, {} as never);
    expect(r1.behavior).toBe("deny");
    expect(r2.behavior).toBe("deny");
    expect(r3.behavior).toBe("allow");
  });

  it("returns undefined when both deny lists are empty", () => {
    expect(buildCanUseTool([])).toBeUndefined();
    expect(buildCanUseTool([], [])).toBeUndefined();
  });
});

describe("sdk-runner — extractText", () => {
  it("returns string content as-is", () => {
    expect(extractText("hello")).toBe("hello");
  });

  it("returns empty for non-array, non-string content", () => {
    expect(extractText(null)).toBe("");
    expect(extractText(42)).toBe("");
    expect(extractText({ foo: "bar" })).toBe("");
  });

  it("joins text blocks with newlines", () => {
    const content = [
      { type: "text", text: "First line" },
      { type: "text", text: "Second line" },
    ];
    expect(extractText(content)).toBe("First line\nSecond line");
  });

  it("formats tool_use blocks as [tool:name] markers", () => {
    const content = [
      { type: "text", text: "Reading the file..." },
      { type: "tool_use", name: "Read", input: { file_path: "x.ts" } },
      { type: "text", text: "Done." },
    ];
    expect(extractText(content)).toBe("Reading the file...\n[tool:Read]\nDone.");
  });

  it("skips blocks of unknown types", () => {
    const content = [
      { type: "text", text: "kept" },
      { type: "image", source: "..." },
      { type: "tool_use", name: "X" },
    ];
    expect(extractText(content)).toBe("kept\n[tool:X]");
  });

  it("skips text blocks with empty/missing text", () => {
    const content = [
      { type: "text", text: "" },
      { type: "text" },
      { type: "text", text: "real" },
    ];
    expect(extractText(content)).toBe("real");
  });
});
