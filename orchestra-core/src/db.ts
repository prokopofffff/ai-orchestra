import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

let pool: pg.Pool;

export function initPool(databaseUrl: string): pg.Pool {
  pool = new Pool({ connectionString: databaseUrl });
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error("Database pool not initialized. Call initPool() first.");
  return pool;
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  const p = initPool(databaseUrl);

  // Check both compiled (dist/) and source (src/) locations
  const dirs = [
    path.join(__dirname, "migrations"),
    path.join(__dirname, "..", "src", "migrations"),
  ];
  let dir = "";
  for (const d of dirs) {
    if (fs.existsSync(d)) {
      dir = d;
      break;
    }
  }

  if (!dir) {
    console.error("Migrations directory not found, checked:", dirs);
    return;
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf-8");
    console.log(`Running migration: ${file}`);
    await p.query(sql);
  }

  console.log(`Ran ${files.length} migrations successfully.`);
}

export async function waitForDatabase(databaseUrl: string, retries = 5): Promise<void> {
  const tempPool = new Pool({ connectionString: databaseUrl });

  for (let i = 0; i < retries; i++) {
    try {
      await tempPool.query("SELECT 1");
      await tempPool.end();
      return;
    } catch {
      console.log(`Waiting for database... (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }

  await tempPool.end();
  throw new Error(`Could not connect to database after ${retries} attempts`);
}
