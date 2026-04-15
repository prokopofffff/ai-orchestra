# Database schema & migrations

## Source of truth

**`src/db/schema.ts`** defines every table in TypeScript. Use it for:

- Inferred row types (`import type { Task, NewTask } from "./db/schema"`)
- Typed queries via Drizzle (`getDb().select().from(tasks).where(...)`)
- Automatic migration generation — `pnpm db:generate` diffs this file
  against the recorded snapshot and emits SQL to `drizzle/`

## Migration workflow (going forward)

1. Edit `src/db/schema.ts` — add a column, new table, whatever.
2. `pnpm db:generate` — drizzle-kit emits a new SQL file in `drizzle/`.
3. Review the generated SQL. Commit it.
4. On next startup, `runMigrations()` applies it through drizzle's migrator,
   tracking in `__drizzle_migrations`.

**Don't hand-write SQL files** in `src/migrations/` anymore.

## Legacy files (`src/migrations/001-012.sql`)

These shaped the DB before we adopted drizzle-kit. They:

- Are idempotent (`IF NOT EXISTS` / `IF EXISTS`) — safe to re-run.
- Are effectively the baseline for any existing deployment.
- Will be collapsed into a single drizzle-kit `_init` migration once all
  running deployments are on the same baseline. Until then they stay.

## Quick reference

| Command | What it does |
|---|---|
| `pnpm db:generate` | Emit migration SQL from schema.ts diff |
| `pnpm db:migrate` | Apply pending drizzle migrations (usually auto-run on boot) |
| `pnpm db:push`   | Push schema.ts directly to DB (dev convenience, no history) |
| `pnpm db:studio` | Open Drizzle Studio (inspect the DB in a browser) |
| `pnpm db:introspect` | Generate a schema.ts from the current live DB |

## Tables NOT managed here

- `graphile_worker.*` — graphile-worker owns and migrates its own schema on
  first boot. We never touch those tables directly.
