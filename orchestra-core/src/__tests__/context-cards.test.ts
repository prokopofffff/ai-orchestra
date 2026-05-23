import { describe, it, expect } from "vitest";
import { renderReferenceCardsBlock, type ReferenceProject } from "../session-context";
import { estimateTokens } from "../context-card-generator";

// Pure-function tests for the context-cards bootstrap path. No DB, no
// filesystem — covers the two pieces that have all the subtle behaviour:
// the greedy budget fill (priority order, per-kind round, drop-on-overflow)
// and the token estimate (used everywhere we budget against the LLM).

function mkRef(id: string, name: string, cards: Array<{ kind: string; content: string; tokenCount: number }>): ReferenceProject {
  return {
    id,
    slug: name.toLowerCase(),
    name,
    description: null,
    absolutePath: `/workspace/${name.toLowerCase()}`,
    readmeExcerpt: null,
    cards,
  };
}

describe("renderReferenceCardsBlock", () => {
  it("returns null when no references have cards", () => {
    const refs = [mkRef("00000000-0000-0000-0000-000000000001", "A", [])];
    expect(renderReferenceCardsBlock(refs, 1000)).toBeNull();
  });

  it("returns null when there are no references at all", () => {
    expect(renderReferenceCardsBlock([], 1000)).toBeNull();
  });

  it("returns null when budget is zero", () => {
    const refs = [mkRef("id-1", "A", [{ kind: "architecture", content: "x", tokenCount: 10 }])];
    expect(renderReferenceCardsBlock(refs, 0)).toBeNull();
  });

  it("includes a single card that fits", () => {
    const refs = [mkRef("id-1", "Alpha", [
      { kind: "architecture", content: "alpha is a TS monorepo", tokenCount: 50 },
    ])];
    const out = renderReferenceCardsBlock(refs, 100);
    expect(out).toContain("## Context cards (from referenced projects)");
    expect(out).toContain("### Alpha");
    expect(out).toContain("**Architecture**");
    expect(out).toContain("alpha is a TS monorepo");
  });

  it("walks priority order: architecture before decisions before style before recent_activity", () => {
    const refs = [mkRef("id-1", "Alpha", [
      { kind: "recent_activity", content: "RA", tokenCount: 5 },
      { kind: "style", content: "STY", tokenCount: 5 },
      { kind: "decisions", content: "DEC", tokenCount: 5 },
      { kind: "architecture", content: "ARCH", tokenCount: 5 },
    ])];
    const out = renderReferenceCardsBlock(refs, 1000) ?? "";
    const archIdx = out.indexOf("**Architecture**");
    const decIdx = out.indexOf("**Decisions**");
    const styIdx = out.indexOf("**Style**");
    const raIdx = out.indexOf("**Recent activity**");
    expect(archIdx).toBeGreaterThanOrEqual(0);
    expect(archIdx).toBeLessThan(decIdx);
    expect(decIdx).toBeLessThan(styIdx);
    expect(styIdx).toBeLessThan(raIdx);
  });

  it("rounds across projects per kind: every ref gets architecture before any ref gets decisions", () => {
    // Tight budget: only 3 architecture cards (50 each = 150) fit; decisions
    // would push us over. Verify that under tight budget, all three projects
    // get a card rather than one project hogging.
    const refs = [
      mkRef("id-1", "Alpha", [
        { kind: "architecture", content: "A-arch", tokenCount: 50 },
        { kind: "decisions", content: "A-dec", tokenCount: 50 },
      ]),
      mkRef("id-2", "Beta", [
        { kind: "architecture", content: "B-arch", tokenCount: 50 },
        { kind: "decisions", content: "B-dec", tokenCount: 50 },
      ]),
      mkRef("id-3", "Gamma", [
        { kind: "architecture", content: "G-arch", tokenCount: 50 },
        { kind: "decisions", content: "G-dec", tokenCount: 50 },
      ]),
    ];
    const out = renderReferenceCardsBlock(refs, 150) ?? "";
    expect(out).toContain("A-arch");
    expect(out).toContain("B-arch");
    expect(out).toContain("G-arch");
    expect(out).not.toContain("A-dec");
    expect(out).not.toContain("B-dec");
    expect(out).not.toContain("G-dec");
  });

  it("drops cards that wouldn't fit, keeps later ones that would", () => {
    // Budget 100, architecture costs 80, decisions costs 200, style costs 15.
    // Architecture fits, decisions doesn't (200 > 20 remaining),
    // style fits (15 <= 20). Verify style appears even though decisions doesn't.
    const refs = [mkRef("id-1", "Alpha", [
      { kind: "architecture", content: "ARCH", tokenCount: 80 },
      { kind: "decisions", content: "DECISIONS", tokenCount: 200 },
      { kind: "style", content: "STYLE", tokenCount: 15 },
    ])];
    const out = renderReferenceCardsBlock(refs, 100) ?? "";
    expect(out).toContain("ARCH");
    expect(out).not.toContain("DECISIONS");
    expect(out).toContain("STYLE");
  });

  it("renders kind labels with underscores expanded to spaces", () => {
    const refs = [mkRef("id-1", "Alpha", [
      { kind: "recent_activity", content: "x", tokenCount: 5 },
    ])];
    const out = renderReferenceCardsBlock(refs, 100) ?? "";
    // "recent_activity" → "Recent activity" — readable header, not a slug.
    expect(out).toContain("**Recent activity**");
    expect(out).not.toContain("**recent_activity**");
  });
});

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("uses chars/4 (rounded up) — within tiktoken's ±20% window for English", () => {
    expect(estimateTokens("a".repeat(4))).toBe(1);
    expect(estimateTokens("a".repeat(8))).toBe(2);
    expect(estimateTokens("a".repeat(7))).toBe(2); // 7/4 = 1.75 → ceil 2
  });
});
