import { describe, it, expect } from "vitest";
import {
  deepMergeSettings,
  normalizeProjectSecretsForWrite,
} from "../project-secrets";

describe("deepMergeSettings", () => {
  it("preserves sibling keys of a nested object on a partial patch", () => {
    const base = { provider: { type: "github", tokenEncrypted: "abc" } };
    const merged = deepMergeSettings(base, { provider: { type: "gitlab" } });
    expect(merged).toEqual({ provider: { type: "gitlab", tokenEncrypted: "abc" } });
  });

  it("preserves untouched top-level buckets", () => {
    const base = { provider: { tokenEncrypted: "abc" }, claude: { auth: "max" } };
    const merged = deepMergeSettings(base, { claude: { auth: "api" } });
    expect(merged).toEqual({ provider: { tokenEncrypted: "abc" }, claude: { auth: "api" } });
  });

  it("treats null as a tombstone that removes the key", () => {
    const base = { provider: { type: "github", tokenEncrypted: "abc" } };
    const merged = deepMergeSettings(base, { provider: { tokenEncrypted: null } });
    expect(merged).toEqual({ provider: { type: "github" } });
  });

  it("replaces arrays rather than merging them", () => {
    const base = { referenceProjects: ["a", "b"] };
    const merged = deepMergeSettings(base, { referenceProjects: ["c"] });
    expect(merged).toEqual({ referenceProjects: ["c"] });
  });

  it("adds new keys and replaces scalars", () => {
    const merged = deepMergeSettings({ a: 1 }, { a: 2, b: 3 });
    expect(merged).toEqual({ a: 2, b: 3 });
  });

  it("does not mutate the base object", () => {
    const base = { provider: { tokenEncrypted: "abc" } };
    deepMergeSettings(base, { provider: { type: "gitlab" } });
    expect(base).toEqual({ provider: { tokenEncrypted: "abc" } });
  });
});

describe("normalize + deepMerge — secret durability", () => {
  it("changing provider.type alone does NOT wipe the stored token", () => {
    // Stored state (token encrypted in flight on a prior save).
    const stored = normalizeProjectSecretsForWrite({
      provider: { type: "github", token: "ghp_secret" },
    }) as { provider: Record<string, unknown> };
    expect(typeof stored.provider.tokenEncrypted).toBe("string");
    expect(stored.provider.token).toBeUndefined();

    // Dashboard sends only the changed type (no token) — the regression case.
    const patch = normalizeProjectSecretsForWrite({ provider: { type: "gitlab" } });
    const merged = deepMergeSettings(stored, patch as Record<string, unknown>) as {
      provider: Record<string, unknown>;
    };

    expect(merged.provider.type).toBe("gitlab");
    expect(merged.provider.tokenEncrypted).toBe(stored.provider.tokenEncrypted);
  });

  it("explicitly clearing the token removes the ciphertext but keeps siblings", () => {
    const stored = normalizeProjectSecretsForWrite({
      provider: { type: "github", token: "ghp_secret" },
    }) as { provider: Record<string, unknown> };

    // Clear flow: empty plaintext → normalize emits a null tombstone.
    const clearPatch = normalizeProjectSecretsForWrite({ provider: { token: "" } }) as {
      provider: Record<string, unknown>;
    };
    expect(clearPatch.provider.tokenEncrypted).toBeNull();

    const merged = deepMergeSettings(stored, clearPatch as Record<string, unknown>) as {
      provider: Record<string, unknown>;
    };
    expect("tokenEncrypted" in merged.provider).toBe(false);
    expect(merged.provider.type).toBe("github");
  });
});
