import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from the workspace root (pnpm dev runs inside orchestra-core/).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config(); // also load local .env if present (override)
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import fastifyJwt from "@fastify/jwt";
import { loadConfig } from "./config";
import { log, requestHook, installProcessTraps } from "./obs";
import { waitForDatabase, runMigrations, getPool } from "./db";
import { taskPlugin } from "./task-api";
import { signalPlugin } from "./signal-api";
import { sessionPlugin } from "./session-api";
import { conversationPlugin } from "./conversation-api";
import { webhookPlugin } from "./webhooks";
import { prPlugin } from "./pr-api";
import { authPlugin } from "./auth-api";
import { usagePlugin } from "./usage-api";
import { requireAuth, isPublicApiPath, SESSION_COOKIE } from "./auth";
import { startHeartbeat, stopHeartbeat } from "./heartbeat";
import { reconcileQueue, getQueueStatus, bindAgentRunner, CLAUDE_BUCKET } from "./rate-limiter";
import { startUsageTracking, stopUsageTracking, getUsage } from "./usage-tracker";
import { getLogs } from "./logger";
import { startTelegramPolling, stopTelegramPolling } from "./telegram-polling";
import { startPrWatcher, stopPrWatcher } from "./pr-watcher";
import { startCostVelocityWatcher, stopCostVelocityWatcher } from "./cost-velocity-watcher";
import { startDispatchReconciler, stopDispatchReconciler } from "./dispatch-reconciler";
import { reconcileOrphanedTasks } from "./dispatcher";
import { startScheduler, stopScheduler, registerBucket } from "./scheduler";
import "./agents/check-handlers"; // side-effect: registers agent:observe-check handler

async function main() {
  installProcessTraps();
  const config = loadConfig();
  const app = Fastify({ loggerInstance: log });

  // Register the request context hook
  requestHook(app);

  // ─── Auth plumbing (cookies + JWT) ───
  await app.register(fastifyCookie);
  await app.register(fastifyJwt, {
    secret: config.jwtSecret,
    cookie: { cookieName: SESSION_COOKIE, signed: false },
  });

  // Gate every /api/* route behind auth except the public ones (auth itself,
  // health, external webhooks). Static dashboard files stay public.
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api")) return;
    if (isPublicApiPath(request.url.split("?")[0])) return;
    return requireAuth(request, reply);
  });

  // ─── Health check ───
  app.get("/api/health", async (_request, reply) => {
    try {
      await getPool().query("SELECT 1");
      return { status: "ok", timestamp: new Date().toISOString() };
    } catch {
      return reply.code(503).send({ status: "unhealthy" });
    }
  });

  // ─── Queue status ───
  app.get("/api/queue/status", async () => {
    const status = await getQueueStatus();
    return status;
  });

  // ─── Usage ───
  app.get("/api/usage", async () => {
    return getUsage();
  });

  // ─── Agent Logs ───
  app.get("/api/logs", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const projectId = query.projectId;
    if (!projectId) return reply.code(400).send({ error: "projectId required" });
    const logs = await getLogs(projectId, {
      sessionId: query.sessionId,
      role: query.role,
      level: query.level as "stdout" | "stderr" | "system" | "error" | undefined,
      limit: Number(query.limit) || 200,
    });
    return logs;
  });

  // ─── API routes ───
  await app.register(authPlugin, { prefix: "/api" });
  await app.register(taskPlugin, { prefix: "/api" });
  await app.register(signalPlugin, { prefix: "/api" });
  await app.register(sessionPlugin, { prefix: "/api" });
  await app.register(conversationPlugin, { prefix: "/api" });
  await app.register(webhookPlugin, { prefix: "/api" });
  await app.register(prPlugin, { prefix: "/api" });
  await app.register(usagePlugin, { prefix: "/api" });

  // ─── Static dashboard ───
  const dashboardRoot = path.resolve(config.dashboardPath);
  await app.register(fastifyStatic, { root: dashboardRoot });

  // SPA fallback — serve index.html for non-API routes
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api")) return reply.code(404).send({ error: "not found" });
    return reply.sendFile("index.html");
  });

  // ─── Error handler ───
  app.setErrorHandler(async (err: Error, _request, reply) => {
    log.error({ err }, "unhandled error");
    if (err.name === "ZodError") {
      return reply.code(400).send({ error: "Validation error", details: err });
    }
    return reply.code(500).send({ error: "Internal server error" });
  });

  // ─── Startup ───
  log.info("waiting for database");
  await waitForDatabase(config.databaseUrl);

  log.info("running migrations");
  await runMigrations(config.databaseUrl);

  // Create first project if configured
  await createFirstProject();

  // Reconcile queue (items stuck as 'running' after restart)
  await reconcileQueue();

  // ─── Job scheduler buckets (must exist before crons reference them) ───
  // GitHub: 5000 req/hr per token = ~1.39/s; keep some headroom.
  await registerBucket({ key: "github:rest", capacity: 100, refillPerSecond: 1 });
  await registerBucket({ key: "github:search", capacity: 30, refillPerSecond: 0.5 });
  // Claude API: drained on 429 to ~5min cooldown. Capacity 50 / refill 0.17/s = ~5min full refill.
  await registerBucket({ key: CLAUDE_BUCKET, capacity: 50, refillPerSecond: 0.17 });

  // Bind agent runner so the agent-run job handler can spawn agents.
  bindAgentRunner(config);

  // Schedule recurring jobs
  await startHeartbeat();
  await startUsageTracking();
  await startPrWatcher();
  await startCostVelocityWatcher();
  await startDispatchReconciler();

  // Start Telegram polling (long-poll loop, not a tick — kept as-is)
  startTelegramPolling();

  // Reconcile tasks that are in active states but have no agent running
  reconcileOrphanedTasks(config).catch((err) => log.error({ err }, "startup reconcile failed"));

  // Start workers — dispatches all crons + ad-hoc jobs
  startScheduler({ concurrency: 4 });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  log.info({
    port: config.port,
    telegram: !!config.telegramBotToken,
    github: !!config.githubToken,
    runtime: process.env.AGENT_RUNTIME ?? "cli",
  }, "orchestra-core listening");

  // ─── Graceful shutdown ───
  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");

    stopHeartbeat();
    stopUsageTracking();
    stopTelegramPolling();
    stopPrWatcher();
    stopCostVelocityWatcher();
    stopDispatchReconciler();
    await stopScheduler();

    await app.close();

    // Mark all running sessions as sleeping (they can be resumed)
    try {
      const pool = getPool();
      const { rowCount } = await pool.query(
        "UPDATE sessions SET status = 'sleeping' WHERE status = 'running'",
      );
      if (rowCount) log.info({ count: rowCount }, "marked sessions as sleeping");
      await pool.end();
    } catch { /* DB might already be down */ }

    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function createFirstProject(): Promise<void> {
  const name = process.env.FIRST_PROJECT_NAME;
  if (!name) return;

  const pool = getPool();
  const { rows } = await pool.query("SELECT id FROM projects LIMIT 1");
  if (rows.length) return;

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const repoUrl = process.env.FIRST_PROJECT_REPO || null;

  const { rows: created } = await pool.query(
    "INSERT INTO projects (name, slug, repo_url) VALUES ($1, $2, $3) RETURNING id",
    [name, slug, repoUrl],
  );

  await pool.query("INSERT INTO conversations (project_id) VALUES ($1)", [created[0].id]);
  log.info({ name, projectId: created[0].id }, "created first project");
}

main().catch((err) => {
  log.fatal({ err }, "failed to start");
  process.exit(1);
});
