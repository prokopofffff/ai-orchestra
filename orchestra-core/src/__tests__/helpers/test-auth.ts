import type { FastifyInstance } from "fastify";
import { getPool } from "../../db";

/**
 * Upsert a test user by email and return its id. Lets test setup seed
 * `owner_id` on projects without spinning up an app first.
 */
export async function getOrCreateTestUser(email = "test@orchestra.local"): Promise<string> {
  const pool = getPool();
  const username = email.split("@")[0].replace(/[^a-z0-9]/gi, "") || "testuser";
  const { rows } = await pool.query(
    `INSERT INTO users (email, username, password_hash)
     VALUES ($1, $2, 'test-stub')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email, username],
  );
  return rows[0].id as string;
}

/**
 * Decorate the Fastify app so every request looks authenticated as the user
 * with the given email. Mirrors what jwtVerify would do in production without
 * dragging cookies / fastify-jwt into every test file.
 *
 * Returns the user id (also used by the test as `owner_id` on projects).
 */
export async function setupTestUser(app: FastifyInstance, email = "test@orchestra.local"): Promise<string> {
  const userId = await getOrCreateTestUser(email);
  const username = email.split("@")[0].replace(/[^a-z0-9]/gi, "") || "testuser";
  app.addHook("preHandler", async (request) => {
    (request as { user?: unknown }).user = { id: userId, email, username };
  });
  return userId;
}
