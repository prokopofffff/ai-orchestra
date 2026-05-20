import { describe, it, expect } from "vitest";
import { parseModelSpec } from "@ai-orchestra/shared";

/**
 * Provider/model spec parsing is the contract between the dashboard's
 * dropdown and the resolver. Fixture-test the parsing rules so a
 * future change can't silently break "select Codex for backend" without
 * the test catching it.
 */
describe("parseModelSpec", () => {
  it("parses 'claude:opus' into provider+model", () => {
    expect(parseModelSpec("claude:opus")).toEqual({ provider: "claude", model: "opus" });
  });

  it("parses 'codex:gpt-5-codex' into provider+model", () => {
    expect(parseModelSpec("codex:gpt-5-codex")).toEqual({ provider: "codex", model: "gpt-5-codex" });
  });

  it("treats bare model names as claude (backward compat for pre-codex projects)", () => {
    expect(parseModelSpec("opus")).toEqual({ provider: "claude", model: "opus" });
    expect(parseModelSpec("sonnet")).toEqual({ provider: "claude", model: "sonnet" });
  });

  it("falls back to claude when an unknown provider prefix is used", () => {
    // Defensive: a typo in settings shouldn't crash the spawner.
    expect(parseModelSpec("gemini:flash")).toEqual({ provider: "claude", model: "gemini:flash" });
  });

  it("preserves colons inside the model portion", () => {
    expect(parseModelSpec("codex:gpt-5.2:turbo")).toEqual({ provider: "codex", model: "gpt-5.2:turbo" });
  });
});
