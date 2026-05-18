import { describe, it, expect } from "vitest";
import {
  scanForCodeBlockViolation,
  stripLongCodeBlocks,
  createGuardState,
} from "../tech-lead-dispatcher";

describe("scanForCodeBlockViolation — streaming guard", () => {
  it("returns null for plain prose", () => {
    const state = createGuardState();
    expect(scanForCodeBlockViolation("This is just text", state)).toBeNull();
    expect(state.open).toBe(false);
  });

  it("returns null for a short fenced code block (≤10 lines)", () => {
    const state = createGuardState();
    const chunk = "intro\n```ts\nconst a = 1;\nconst b = 2;\n```\noutro";
    expect(scanForCodeBlockViolation(chunk, state)).toBeNull();
    expect(state.open).toBe(false);
  });

  it("flags a code-language block longer than 10 lines", () => {
    const state = createGuardState();
    const longBlock = "```js\n" + Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n") + "\n```";
    expect(scanForCodeBlockViolation(longBlock, state)).toMatch(/code block exceeded 10 lines/);
  });

  it("tracks open state across multiple stream chunks (code fence)", () => {
    const state = createGuardState();
    const first = "```ts\n" + Array.from({ length: 5 }, (_, i) => `a${i}`).join("\n");
    const second = Array.from({ length: 6 }, (_, i) => `b${i}`).join("\n");
    expect(scanForCodeBlockViolation(first, state)).toBeNull();
    expect(state.open).toBe(true);
    expect(state.isCode).toBe(true);
    expect(state.lines).toBe(5);
    expect(scanForCodeBlockViolation(second, state)).toMatch(/exceeded/);
  });

  it("resets line count and isCode flag when a block closes", () => {
    const state = createGuardState();
    const chunk = "```ts\nshort\nblock\n```\nmore prose\n```text\nother\n```";
    expect(scanForCodeBlockViolation(chunk, state)).toBeNull();
    expect(state.open).toBe(false);
    expect(state.lines).toBe(0);
    expect(state.isCode).toBe(false);
  });

  it("allows long un-tagged fences (ASCII trees, prose dumps) up to 50 lines", () => {
    const state = createGuardState();
    const tree = "```\n" + Array.from({ length: 30 }, (_, i) => `├─ item ${i}`).join("\n") + "\n```";
    expect(scanForCodeBlockViolation(tree, state)).toBeNull();
  });

  it("allows long `text` / `tree` / `mermaid` fences up to 50 lines", () => {
    for (const lang of ["text", "tree", "mermaid"]) {
      const state = createGuardState();
      const block = "```" + lang + "\n" + Array.from({ length: 25 }, (_, i) => `l${i}`).join("\n") + "\n```";
      expect(scanForCodeBlockViolation(block, state)).toBeNull();
    }
  });

  it("flags an un-tagged fence longer than 50 lines", () => {
    const state = createGuardState();
    const huge = "```\n" + Array.from({ length: 55 }, (_, i) => `l${i}`).join("\n") + "\n```";
    expect(scanForCodeBlockViolation(huge, state)).toMatch(/text\/diagram block exceeded 50 lines/);
  });

  it("flags the actual ASCII task-tree case if it goes beyond 50 lines", () => {
    const state = createGuardState();
    const bigTree = "```\n" + Array.from({ length: 60 }, (_, i) => `└─ task ${i}`).join("\n") + "\n```";
    expect(scanForCodeBlockViolation(bigTree, state)).toMatch(/text\/diagram block exceeded 50 lines/);
  });
});

describe("stripLongCodeBlocks — post-hoc sanitizer", () => {
  it("leaves prose untouched", () => {
    expect(stripLongCodeBlocks("hello, world")).toBe("hello, world");
  });

  it("preserves short illustrative code snippets (≤10 lines)", () => {
    const input = "config:\n```ts\nport: 8080\n```\ndone";
    expect(stripLongCodeBlocks(input)).toBe(input);
  });

  it("replaces code-language blocks longer than 10 lines with a marker", () => {
    const longBlock = "```js\n" + Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n") + "\n```";
    const result = stripLongCodeBlocks(`prefix\n${longBlock}\nsuffix`);
    expect(result).toMatch(/_\(removed: 30-line code block/);
    expect(result).toContain("prefix");
    expect(result).toContain("suffix");
    expect(result).not.toContain("line0");
  });

  it("handles multiple long code-language blocks in one reply", () => {
    const block = (n: number) => "```ts\n" + Array.from({ length: 20 }, (_, i) => `${n}_${i}`).join("\n") + "\n```";
    const input = `intro\n${block(1)}\nmid\n${block(2)}\nend`;
    const out = stripLongCodeBlocks(input);
    const matches = out.match(/_\(removed: 20-line code/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("preserves un-tagged ASCII trees up to 50 lines", () => {
    const tree = "```\n" + Array.from({ length: 30 }, (_, i) => `├─ item ${i}`).join("\n") + "\n```";
    const input = `Here's the plan:\n${tree}\nlet's go`;
    expect(stripLongCodeBlocks(input)).toBe(input);
  });

  it("strips un-tagged blocks that go beyond 50 lines (text-cap marker)", () => {
    const huge = "```\n" + Array.from({ length: 55 }, (_, i) => `l${i}`).join("\n") + "\n```";
    const out = stripLongCodeBlocks(huge);
    expect(out).toMatch(/_\(removed: 55-line text block/);
  });
});
