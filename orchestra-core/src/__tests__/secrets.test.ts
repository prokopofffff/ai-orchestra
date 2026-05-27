import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  encryptJson,
  decryptJson,
  _resetKeyCacheForTesting,
} from "../secrets";

describe("secrets", () => {
  beforeAll(() => {
    process.env.ORCHESTRA_SECRETS_KEY = randomBytes(32).toString("base64");
    _resetKeyCacheForTesting();
  });

  describe("encryptSecret / decryptSecret", () => {
    it("round-trips a plaintext string", () => {
      const ct = encryptSecret("hello world");
      expect(decryptSecret(ct)).toBe("hello world");
    });

    it("produces different ciphertext for the same plaintext (random IV)", () => {
      expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
    });

    it("throws on tampered ciphertext", () => {
      const ct = encryptSecret("payload");
      const buf = Buffer.from(ct, "base64");
      buf[buf.length - 1] ^= 1;
      const tampered = buf.toString("base64");
      expect(() => decryptSecret(tampered)).toThrow();
    });
  });

  describe("encryptJson / decryptJson", () => {
    it("round-trips an object", () => {
      const value = { DATABASE_URL: "postgres://x", API_KEY: "sk-abc" };
      const ct = encryptJson(value);
      expect(decryptJson<typeof value>(ct)).toEqual(value);
    });

    it("round-trips arrays and primitives", () => {
      expect(decryptJson<number[]>(encryptJson([1, 2, 3]))).toEqual([1, 2, 3]);
      expect(decryptJson<string>(encryptJson("just a string"))).toBe("just a string");
    });

    it("does not leak structure in ciphertext", () => {
      const a = encryptJson({ FOO: "x" });
      const b = encryptJson({ FOO: "y" });
      expect(a).not.toBe(b);
      // GCM-tag + ciphertext are different even for tiny diffs.
      expect(a.length).toBeGreaterThan(20);
    });
  });
});
