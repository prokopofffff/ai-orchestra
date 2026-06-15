/**
 * Observability primitives — structured logging + ambient context.
 *
 * - `log` is a pino root logger. JSON in production, pretty in dev.
 * - Ambient context (reqId, projectId, jobId, role, …) propagates through
 *   AsyncLocalStorage. Any code path that runs inside `withContext()` (or
 *   one of the Fastify/job wrappers below) gets that context attached to
 *   every log line automatically — no manual plumbing required.
 *
 * NOT to be confused with `./logger.ts`, which writes to the `agent_logs`
 * DB table for per-agent-run audit. This module is for runtime diagnostics.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import pino, { type Logger } from "pino";
import type { FastifyInstance, RawServerDefault } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";

// ─── Context ───

export type LogContext = {
  reqId?: string;
  projectId?: string;
  taskId?: string;
  sessionId?: string;
  jobId?: string;
  jobKind?: string;
  attempt?: number;
  role?: string;
  [k: string]: unknown;
};

const als = new AsyncLocalStorage<LogContext>();

export function getContext(): LogContext {
  return als.getStore() ?? {};
}

/**
 * Run `fn` with the given context merged into the active context.
 * Nested calls inherit the parent's context.
 */
export function withContext<T>(ctx: LogContext, fn: () => Promise<T>): Promise<T> {
  const merged = { ...getContext(), ...ctx };
  return als.run(merged, fn);
}

// ─── Root logger ───

const isProd = process.env.NODE_ENV === "production";

export const log: Logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
  // Inject ambient context into every log line.
  mixin: () => ({ ctx: getContext() }),
  // Best-effort scrub of credentials that occasionally ride along in logged
  // objects (request headers, settings blobs, error payloads). Covers both
  // top-level and one-level-nested occurrences of the common secret keys.
  redact: {
    paths: [
      "token", "apiKey", "password", "password_hash", "secret", "jwtSecret",
      "authorization", "cookie", "agentJwt", "tokenEncrypted", "apiKeyEncrypted",
      "*.token", "*.apiKey", "*.password", "*.password_hash", "*.secret",
      "*.authorization", "*.cookie", "*.agentJwt", "*.tokenEncrypted", "*.apiKeyEncrypted",
      "req.headers.authorization", "req.headers.cookie",
      "headers.authorization", "headers.cookie",
    ],
    censor: "[redacted]",
  },
  ...(isProd ? {} : {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, singleLine: false, translateTime: "HH:MM:ss.l" },
    },
  }),
});

// ─── Fastify request hook ───
//
// Generates a reqId, runs the rest of the request inside withContext so any
// log call from downstream handlers carries reqId automatically.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function requestHook(app: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, any>): void {
  app.addHook("onRequest", async (request) => {
    const reqId = (request.headers["x-request-id"] as string | undefined) ?? randomUUID();
    als.enterWith({ ...getContext(), reqId });
  });
}

// ─── Process-level traps ───
//
// Without these, uncaught errors print to stderr unstructured. Capture them
// through pino so they land in whatever sink we're using.

export function installProcessTraps(): void {
  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "unhandledRejection");
  });
}
