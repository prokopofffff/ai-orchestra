import { describe, it, expect } from "vitest";
import { scanForCodeBlockViolation, stripLongCodeBlocks } from "../tech-lead-dispatcher";

describe("scanForCodeBlockViolation — streaming guard", () => {
  it("returns null for plain prose", () => {
    const state = { open: false, lines: 0 };
    expect(scanForCodeBlockViolation("This is just text", state)).toBeNull();
    expect(state.open).toBe(false);
  });

  it("returns null for a short fenced block (≤10 lines)", () => {
    const state = { open: false, lines: 0 };
    const chunk = "intro\n```ts\nconst a = 1;\nconst b = 2;\n```\noutro";
    expect(scanForCodeBlockViolation(chunk, state)).toBeNull();
    expect(state.open).toBe(false); // closed cleanly
  });

  it("flags a single block longer than 10 lines", () => {
    const state = { open: false, lines: 0 };
    const longBlock = "```js\n" + Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n") + "\n```";
    expect(scanForCodeBlockViolation(longBlock, state)).toMatch(/exceeded 10 lines/);
  });

  it("tracks open state across multiple stream chunks", () => {
    const state = { open: false, lines: 0 };
    // First chunk opens a fence + 5 lines, second chunk adds 6 more — total 11 = violation.
    const first = "```ts\n" + Array.from({ length: 5 }, (_, i) => `a${i}`).join("\n");
    const second = Array.from({ length: 6 }, (_, i) => `b${i}`).join("\n");
    expect(scanForCodeBlockViolation(first, state)).toBeNull();
    expect(state.open).toBe(true);
    expect(state.lines).toBe(5);
    expect(scanForCodeBlockViolation(second, state)).toMatch(/exceeded/);
  });

  it("resets line count when a block closes", () => {
    const state = { open: false, lines: 0 };
    const chunk = "```\nshort\nblock\n```\nmore prose\n```\nother\n```";
    expect(scanForCodeBlockViolation(chunk, state)).toBeNull();
    expect(state.open).toBe(false);
    expect(state.lines).toBe(0);
  });
});

describe("stripLongCodeBlocks — post-hoc sanitizer", () => {
  it("leaves prose untouched", () => {
    expect(stripLongCodeBlocks("hello, world")).toBe("hello, world");
  });

  it("preserves short illustrative snippets (≤10 lines)", () => {
    const input = "config:\n```ts\nport: 8080\n```\ndone";
    expect(stripLongCodeBlocks(input)).toBe(input);
  });

  it("replaces blocks longer than 10 lines with a marker", () => {
    const longBlock = "```js\n" + Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n") + "\n```";
    const result = stripLongCodeBlocks(`prefix\n${longBlock}\nsuffix`);
    expect(result).toMatch(/_\(removed: 30-line code block/);
    expect(result).toContain("prefix");
    expect(result).toContain("suffix");
    expect(result).not.toContain("line0");
  });

  it("handles multiple long blocks in one reply", () => {
    const block = (n: number) => "```ts\n" + Array.from({ length: 20 }, (_, i) => `${n}_${i}`).join("\n") + "\n```";
    const input = `intro\n${block(1)}\nmid\n${block(2)}\nend`;
    const out = stripLongCodeBlocks(input);
    const matches = out.match(/_\(removed: 20-line/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("ignores fences with no language tag", () => {
    const longBlock = "```\n" + Array.from({ length: 15 }, () => "x").join("\n") + "\n```";
    expect(stripLongCodeBlocks(longBlock)).toMatch(/removed: 15-line/);
  });
});
