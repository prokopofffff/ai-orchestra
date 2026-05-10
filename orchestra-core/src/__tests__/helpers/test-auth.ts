import type { FastifyInstance } from "fastify";
import { getPool } from "../../db";

/**
 * Insert a real test user (or return the existing one with the same email)
 * and decorate the Fastify app so every request looks authenticated as that
 * user. Mirrors what jwtVerify would do in production without dragging cookies
 * / fastify-jwt into every test file.
 *
 * Returns the user id so tests can set `owner_id` directly when seeding rows.
 */
export async function setupTestUser(app: FastifyInstance, email = "test@orchestra.local"): Promise<string> {
  const pool = getPool();
  const username = email.split("@")[0].replace(/[^a-z0-9]/gi, "") || "testuser";
  const { rows } = await pool.query(
    `INSERT INTO users (email, username, password_hash)
     VALUES ($1, $2, 'test-stub')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email, username],
  );
  const userId = rows[0].id as string;

  app.addHook("preHandler", async (request) => {
    (request as { user?: unknown }).user = { id: userId, email, username };
  });

  return userId;
}
