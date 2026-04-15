import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadSystemPrompt, buildScopeRules, assemblePrompt } from "../agents/prompt";
import { agentConfigs } from "../agents/configs";

const PROMPTS_DIR = path.join(process.cwd(), "prompts");
const tempFiles: string[] = [];

function writeTempPrompt(name: string, body: string): void {
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  const p = path.join(PROMPTS_DIR, `${name}.md`);
  fs.writeFileSync(p, body);
  tempFiles.push(p);
}

afterAll(() => {
  for (const p of tempFiles) fs.unlinkSync(p);
});

describe("prompt — loadSystemPrompt", () => {
  beforeAll(() => {
    writeTempPrompt("dev-frontend", "FRONTEND PROMPT");
    writeTempPrompt("designer", "DESIGNER PROMPT");
    writeTempPrompt("designer-no-pencil", "DESIGNER NO PENCIL PROMPT");
  });

  it("loads the role's prompt file", () => {
    expect(loadSystemPrompt("frontend")).toBe("FRONTEND PROMPT");
  });

  it("uses the fallback file for designer when pencil is disabled", () => {
    expect(loadSystemPrompt("designer", { pencilEnabled: false })).toBe("DESIGNER NO PENCIL PROMPT");
  });

  it("uses the primary file for designer when pencil is enabled", () => {
    expect(loadSystemPrompt("designer", { pencilEnabled: true })).toBe("DESIGNER PROMPT");
  });

  it("returns empty string when the prompt file is missing", () => {
    // backend prompt may or may not exist on disk — temporarily blow away the role's promptFile pointer
    const orig = agentConfigs.qa.promptFile;
    agentConfigs.qa.promptFile = "definitely-not-a-prompt-file";
    try {
      expect(loadSystemPrompt("qa")).toBe("");
    } finally {
      agentConfigs.qa.promptFile = orig;
    }
  });
});

describe("prompt — buildScopeRules", () => {
  it("returns empty for unrestricted roles (tech-lead)", () => {
    expect(buildScopeRules("tech-lead")).toBe("");
  });

  it("renders allowed + denied for scoped roles", () => {
    const rules = buildScopeRules("backend");
    expect(rules).toContain("Scope Rules");
    expect(rules).toContain("src/backend/**");
    expect(rules).toContain("must NOT modify");
    expect(rules).toContain("src/frontend/**");
  });

  it("omits the 'must NOT modify' line when no denied patterns exist", () => {
    // qa has no denied list
    const rules = buildScopeRules("qa");
    expect(rules).toContain("Scope Rules");
    expect(rules).not.toContain("must NOT modify");
  });
});

describe("prompt — assemblePrompt", () => {
  it("joins systemPrompt + scope + bootstrap + tail with separators", () => {
    const out = assemblePrompt({
      systemPrompt: "SYS",
      scope: "SCOPE",
      bootstrap: "BOOT",
      tail: "TAIL",
    });
    expect(out).toContain("SYS");
    expect(out).toContain("SCOPE");
    expect(out).toContain("---");
    expect(out).toContain("BOOT");
    expect(out).toContain("TAIL");
    // Order matters
    expect(out.indexOf("SYS")).toBeLessThan(out.indexOf("SCOPE"));
    expect(out.indexOf("SCOPE")).toBeLessThan(out.indexOf("BOOT"));
    expect(out.indexOf("BOOT")).toBeLessThan(out.indexOf("TAIL"));
  });

  it("skips empty parts (no scope, no tail)", () => {
    const out = assemblePrompt({ systemPrompt: "SYS", bootstrap: "BOOT" });
    expect(out).toContain("SYS");
    expect(out).toContain("BOOT");
    expect(out).toContain("---");
    // No empty newlines from omitted optional parts
    expect(out).not.toMatch(/\n{4,}/);
  });

  it("works with only bootstrap (e.g. role with no system prompt file)", () => {
    const out = assemblePrompt({ systemPrompt: "", bootstrap: "BOOT" });
    expect(out).toContain("BOOT");
  });
});
