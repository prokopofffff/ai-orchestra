import { defineConfig } from "vitest/config";

const DEFAULT_DATABASE_URL =
  "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

// Tests run against a sibling `<db>_test` database so a running `pnpm dev`
// (whose graphile-worker subscribes to the dev DB) doesn't race vitest for
// the test-fixture jobs. The pretest script (`ensure-test-db.ts`) creates
// this DB on demand; migrations run inside each suite's setup hook.
function testDatabaseUrl(): string {
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const name = url.pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) url.pathname = `/${name}_test`;
  return url.toString();
}

export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 10000,
    fileParallelism: false,
    // Route handlers call loadConfig() which reads from process.env.
    // Tests pass DATABASE_URL to waitForDatabase directly; mirror it here so
    // routes can also load config without ENOENT/ZodError 500s.
    env: {
      DATABASE_URL: testDatabaseUrl(),
    },
  },
});
