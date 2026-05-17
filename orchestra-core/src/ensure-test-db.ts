/**
 * Ensures the test database exists before vitest runs.
 *
 * Tests use a separate DB (suffix `_test`) so they don't race the dev
 * server's graphile-worker for jobs the tests insert as fixtures. Without
 * this isolation, running `pnpm test` while `pnpm dev` is up makes the
 * agent-checks and pr-watcher suites flap — the dev runner claims jobs
 * a hair before the test assertion can see them.
 *
 * Derives the test DB name from DATABASE_URL (or the same default the
 * vitest config uses), connects to Postgres' admin DB, and issues
 * CREATE DATABASE if it isn't already there.
 */
import { Pool } from "pg";

const DEFAULT_DATABASE_URL =
  "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

const base = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
const baseName = base.pathname.replace(/^\//, "") || "orchestra";
const testName = baseName.endsWith("_test") ? baseName : `${baseName}_test`;

const admin = new URL(base.toString());
admin.pathname = "/postgres";

const pool = new Pool({ connectionString: admin.toString() });
try {
  const { rowCount } = await pool.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [testName],
  );
  if (!rowCount) {
    // Identifier is derived from a trusted source (env or hard-coded
    // default); pg doesn't bind identifiers, so we quote it explicitly.
    await pool.query(`CREATE DATABASE "${testName.replace(/"/g, '""')}"`);
    console.log(`ensure-test-db: created database "${testName}"`);
  }
} finally {
  await pool.end();
}
