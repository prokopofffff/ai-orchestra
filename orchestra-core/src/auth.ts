import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyRequest, FastifyReply } from "fastify";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const SALT_LEN = 16;
const HASH_LEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scryptAsync(password, salt, HASH_LEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const SESSION_COOKIE = "orchestra_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { id: string; email: string; username: string };
    user: { id: string; email: string; username: string };
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }
}

/** Routes under /api that bypass auth (login/signup, health, external webhooks). */
export function isPublicApiPath(url: string): boolean {
  if (url.startsWith("/api/auth/")) return true;
  if (url === "/api/health") return true;
  if (url.startsWith("/api/webhooks/")) return true;
  return false;
}

/**
 * Extract the authenticated user id from the request. Assumes `requireAuth`
 * already ran — throws if jwtVerify wasn't done. Use this in handlers that
 * need to scope queries by current user.
 */
export function currentUserId(request: FastifyRequest): string {
  const u = request.user as { id?: string } | undefined;
  if (!u?.id) throw new Error("currentUserId called without prior auth");
  return u.id;
}
