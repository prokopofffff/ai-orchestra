import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { log } from "./obs";

/**
 * AES-256-GCM helpers for storing per-project credentials (git PATs, etc.)
 * encrypted at rest. Multi-tenant orchestra installations must not let a
 * DB-level snoop read plaintext tokens belonging to other tenants — this
 * module is the single point of crypto for that.
 *
 * Key provisioning: ORCHESTRA_SECRETS_KEY env, base64-encoded 32 bytes.
 * Generate one with:  `openssl rand -base64 32`
 *
 * In production (NODE_ENV=production) the absence of the env triggers a
 * hard startup error — better to fail loudly than silently fall back to a
 * random key that won't survive a restart and would brick every encrypted
 * value on the next boot.
 *
 * In development a missing key is replaced with an ephemeral random key
 * with a warning. Encrypted values written during that boot will be
 * undecryptable after restart — fine for local hacking, never for prod.
 */

const ALGO = "aes-256-gcm";
const KEY_LEN = 32; // 256 bits
const IV_LEN = 12; // GCM-recommended

function loadKey(): Buffer {
  const raw = process.env.ORCHESTRA_SECRETS_KEY;
  if (raw && raw.length > 0) {
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== KEY_LEN) {
      throw new Error(
        `ORCHESTRA_SECRETS_KEY must decode to ${KEY_LEN} bytes — got ${buf.length}. ` +
          `Generate one with: openssl rand -base64 ${KEY_LEN}`,
      );
    }
    return buf;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "ORCHESTRA_SECRETS_KEY is required in production. " +
        "Generate one with: openssl rand -base64 32",
    );
  }
  const ephemeral = randomBytes(KEY_LEN);
  log.warn(
    { ephemeralKeyB64: ephemeral.toString("base64").slice(0, 8) + "…" },
    "ORCHESTRA_SECRETS_KEY not set — generated ephemeral key. " +
      "Encrypted values WILL NOT survive a restart. " +
      "Set ORCHESTRA_SECRETS_KEY in your .env for persistence.",
  );
  return ephemeral;
}

// Lazy so tests + scripts that don't touch encryption don't trip the
// production-env check.
let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (cachedKey === null) cachedKey = loadKey();
  return cachedKey;
}

/** Wire format: base64(iv ‖ tag ‖ ciphertext). Self-contained. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

/**
 * Decrypt a previously-encrypted blob. Throws on tag mismatch (tampering)
 * or key rotation (ciphertext written under a different key).
 */
export function decryptSecret(encoded: string): string {
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < IV_LEN + 16 + 1) {
    throw new Error("encrypted blob is too short to be valid");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + 16);
  const ct = buf.subarray(IV_LEN + 16);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf-8");
}

/**
 * Test-only: reset the cached key so a unit test can swap the env var
 * mid-suite. Not exported in production builds — call via internal name.
 */
export function _resetKeyCacheForTesting(): void {
  cachedKey = null;
}
