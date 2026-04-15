import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { log } from "./obs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

let pool: pg.Pool;
let db: NodePgDatabase;

export function initPool(databaseUrl: string): pg.Pool {
  pool = new Pool({ connectionString: databaseUrl });
  db = drizzle(pool);
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error("Database pool not initialized. Call initPool() first.");
  return pool;
}

export function getDb(): NodePgDatabase {
  if (!db) throw new Error("Database not initialized. Call initPool() first.");
  return db;
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  initPool(databaseUrl);

  // Two stages:
  //   1. Legacy raw-SQL files in src/migrations/ — the historical baseline.
  //      All idempotent (IF NOT EXISTS / IF EXISTS), safe to re-run.
  //   2. Drizzle-kit generated migrations in drizzle/ — schema.ts is the
  //      source of truth going forward; `pnpm db:generate` emits SQL here.

  await applyLegacySqlMigrations();
  await applyDrizzleMigrations();
}

async function applyLegacySqlMigrations(): Promise<void> {
  // Check both compiled (dist/) and source (src/) locations.
  const dirs = [
    path.join(__dirname, "migrations"),
    path.join(__dirname, "..", "src", "migrations"),
  ];
  const dir = dirs.find((d) => fs.existsSync(d));
  if (!dir) {
    log.warn({ dirs }, "legacy migrations directory not found");
    return;
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf-8");
    log.info({ file }, "running legacy migration");
    await getPool().query(sql);
  }
  log.info({ count: files.length }, "legacy migrations applied");
}

async function applyDrizzleMigrations(): Promise<void> {
  // drizzle-kit outputs migrations to ./drizzle next to this package.
  const candidates = [
    path.join(__dirname, "..", "drizzle"),
    path.join(__dirname, "..", "..", "drizzle"),
  ];
  const migrationsFolder = candidates.find((d) => fs.existsSync(path.join(d, "meta", "_journal.json")));
  if (!migrationsFolder) {
    log.debug("no drizzle migrations yet — skipping");
    return;
  }
  await migrate(getDb(), { migrationsFolder });
  log.info({ migrationsFolder }, "drizzle migrations applied");
}

export async function waitForDatabase(databaseUrl: string, retries = 5): Promise<void> {
  const tempPool = new Pool({ connectionString: databaseUrl });

  for (let i = 0; i < retries; i++) {
    try {
      await tempPool.query("SELECT 1");
      await tempPool.end();
      return;
    } catch {
      log.info({ attempt: i + 1, retries }, "waiting for database");
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }

  await tempPool.end();
  throw new Error(`Could not connect to database after ${retries} attempts`);
}
