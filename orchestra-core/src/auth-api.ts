import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  SignupSchema, LoginRequestSchema, UserSchema,
  type User,
} from "@ai-orchestra/shared";
import { getPool } from "./db";
import { hashPassword, verifyPassword, requireAuth, isInstanceAdmin, SESSION_COOKIE, SESSION_MAX_AGE } from "./auth";

interface UserRow {
  id: string;
  email: string;
  username: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}

function toUser(row: UserRow): User {
  return UserSchema.parse({
    id: row.id,
    email: row.email,
    username: row.username,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string): void {
  // Mirror the request's protocol — `Secure: true` over plain HTTP makes the
  // browser silently drop the cookie, which kills login on HTTP-only
  // deployments (no TLS proxy in front of the box). Behind a TLS-terminating
  // proxy, `request.protocol` reads `X-Forwarded-Proto` once Fastify is
  // configured with `trustProxy` — until then it reflects the direct hop.
  const isHttps = request.protocol === "https";
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps,
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export const authPlugin: FastifyPluginAsync = async (app) => {
  app.post("/auth/signup", async (request, reply) => {
    const body = SignupSchema.parse(request.body);
    const pool = getPool();

    const { rows: existing } = await pool.query<{ field: string }>(
      `SELECT
         CASE WHEN lower(email) = lower($1) THEN 'email' ELSE 'username' END AS field
       FROM users
       WHERE lower(email) = lower($1) OR lower(username) = lower($2)
       LIMIT 1`,
      [body.email, body.username],
    );
    if (existing.length) {
      return reply.code(409).send({
        error: existing[0].field === "email" ? "Этот email уже используется" : "Это имя пользователя уже занято",
      });
    }

    const hash = await hashPassword(body.password);
    const { rows } = await pool.query<UserRow>(
      `INSERT INTO users (email, username, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, username, password_hash, created_at, updated_at`,
      [body.email, body.username, hash],
    );

    const user = toUser(rows[0]);

    // First-user-on-fresh-install backfill: if every existing project is
    // ownerless (e.g. legacy install where projects predated users), assign
    // them all to this brand-new account. Migration 017 already does this
    // when there's at least one user at apply time, but covers the case of
    // users being deleted or projects created before signup ever happened.
    const { rows: countRow } = await pool.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM users",
    );
    if (countRow[0].c === 1) {
      await pool.query(
        "UPDATE projects SET owner_id = $1 WHERE owner_id IS NULL",
        [user.id],
      );
    }

    const token = await reply.jwtSign(
      { id: user.id, email: user.email, username: user.username },
      { expiresIn: SESSION_MAX_AGE },
    );
    setSessionCookie(request, reply, token);
    return reply.code(201).send(user);
  });

  app.post("/auth/login", async (request, reply) => {
    const body = LoginRequestSchema.parse(request.body);
    const pool = getPool();

    const { rows } = await pool.query<UserRow>(
      `SELECT id, email, username, password_hash, created_at, updated_at
       FROM users
       WHERE lower(email) = lower($1)`,
      [body.email],
    );
    if (!rows.length) {
      // Constant-time-ish: run a scrypt pass even when the account doesn't
      // exist, so response latency doesn't reveal whether an email is
      // registered (user-enumeration oracle).
      await hashPassword(body.password);
      return reply.code(401).send({ error: "Неверный email или пароль" });
    }

    const valid = await verifyPassword(body.password, rows[0].password_hash);
    if (!valid) return reply.code(401).send({ error: "Неверный email или пароль" });

    const user = toUser(rows[0]);
    const token = await reply.jwtSign(
      { id: user.id, email: user.email, username: user.username },
      { expiresIn: SESSION_MAX_AGE },
    );
    setSessionCookie(request, reply, token);
    return reply.send(user);
  });

  app.post("/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.send({ ok: true });
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const pool = getPool();
    const { rows } = await pool.query<UserRow>(
      `SELECT id, email, username, password_hash, created_at, updated_at
       FROM users WHERE id = $1`,
      [request.user.id],
    );
    if (!rows.length) {
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(401).send({ error: "Не авторизован" });
    }
    return { ...toUser(rows[0]), isAdmin: await isInstanceAdmin(rows[0].id) };
  });
};
