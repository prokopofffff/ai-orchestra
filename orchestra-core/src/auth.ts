import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyRequest, FastifyReply } from "fastify";
import { userCanEditProject, userCanAccessProject } from "./project-access";
import { getPool } from "./db";

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

/**
 * JWT claim shape. Human session tokens carry only identity. Agent tokens
 * (minted server-side in agent-jwt.ts before a spawn) additionally carry
 * `kind: "agent"` plus the spawned `role` and the single `projectId` the
 * agent is allowed to act on. Role/project therefore come from the *signed*
 * token, never from a client-supplied header.
 */
type JwtClaims = {
  id: string;
  email: string;
  username: string;
  kind?: "agent";
  role?: string;
  projectId?: string;
};

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtClaims;
    user: JwtClaims;
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "Не авторизован" });
  }
}

/** Routes under /api that bypass auth (login/signup, health, external webhooks). */
export function isPublicApiPath(url: string): boolean {
  if (url.startsWith("/api/auth/")) return true;
  if (url === "/api/health") return true;
  // External git providers POST here with their own HMAC signature — they have
  // no orchestra session. Routes are registered under /api/git/webhook* (see
  // webhooks.ts); the old "/api/webhooks/" prefix never matched, so every
  // webhook delivery was being rejected with 401 by the global auth gate.
  if (url.startsWith("/api/git/webhook")) return true;
  // OAuth callbacks: the git provider redirects the user's browser here with
  // no orchestra session (cross-site redirect). Trust comes from the signed
  // `state` param instead — see git-connect-api.ts. Only /callback bypasses
  // auth; /connect, /config and /identity stay gated.
  if (url === "/api/git/github/callback") return true;
  if (url === "/api/git/gitlab/callback") return true;
  // GitHub App manifest flow redirects here after the admin creates the app;
  // trust comes from the signed `state` + an admin re-check in the handler.
  if (url === "/api/git/github/manifest-callback") return true;
  return false;
}

/**
 * If the verified JWT is an agent token, return its role + project scope;
 * otherwise null (human session). Handlers use this instead of trusting the
 * spoofable `x-agent-role` header: an agent's role/project are bound into the
 * signed token, so a logged-in human can't impersonate an agent and a
 * compromised agent can't act outside the one project it was minted for.
 */
export function agentContext(request: FastifyRequest): { role: string; projectId: string } | null {
  const u = request.user as JwtClaims | undefined;
  if (u?.kind === "agent" && u.role && u.projectId) {
    return { role: u.role, projectId: u.projectId };
  }
  return null;
}

export type ProjectAuthz =
  | { ok: true; agentRole?: string }
  | { ok: false; reason: "scope-mismatch" | "no-access" };

/**
 * Single decision point for "may this caller act on `projectId`". An agent
 * token must be scoped to exactly this project; a human must have `edit` or
 * `access` rights (per `level`). Returns the agent's role on success so callers
 * can layer capability checks on top. Centralizes the spoof-prevention
 * invariant so it can't drift between the routes that use it.
 */
export async function authorizeProject(
  request: FastifyRequest,
  projectId: string,
  level: "edit" | "access",
): Promise<ProjectAuthz> {
  const agent = agentContext(request);
  if (agent) {
    return agent.projectId === projectId
      ? { ok: true, agentRole: agent.role }
      : { ok: false, reason: "scope-mismatch" };
  }
  const userId = currentUserId(request);
  const allowed = level === "edit"
    ? await userCanEditProject(userId, projectId)
    : await userCanAccessProject(userId, projectId);
  return allowed ? { ok: true } : { ok: false, reason: "no-access" };
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

/**
 * Instance admin = the earliest-registered user. New signups always get a
 * later created_at, so whoever registered first stays admin. This is the one
 * account allowed to manage deployment-wide config (the GitHub App / GitLab
 * OAuth integration, system defaults). Returns true when `userId` is admin.
 */
export async function isInstanceAdmin(userId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    "SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1",
  );
  return rows.length > 0 && rows[0].id === userId;
}

/** Guard for admin-only routes — replies 403 and returns false when not admin. */
export async function requireInstanceAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (await isInstanceAdmin(currentUserId(request))) return true;
  reply.code(403).send({ error: "Доступно только администратору инстанса" });
  return false;
}
