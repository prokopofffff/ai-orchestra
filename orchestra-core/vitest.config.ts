import { defineConfig } from "vitest/config";

const DEFAULT_DATABASE_URL =
  "postgres://orchestra:158gvaT63ASEsAwZSt8l1piKGheHWvPe@127.0.0.1:5434/orchestra";

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
      DATABASE_URL: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    },
  },
});
