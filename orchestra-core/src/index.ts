import express from "express";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { createSignalRouter } from "./signal-api.js";
import { AgentSpawner, SpawnAgentInputSchema } from "./agent-spawner.js";
import { RateLimiter } from "./rate-limiter.js";
import { FlowGuard } from "./flow-guard.js";
import { createWebhookRouter } from "./webhooks.js";

async function main() {
  const config = loadConfig();
  const app = express();

  app.use(express.json());

  // Shared database pool
  const pool = new Pool({ connectionString: config.databaseUrl });

  // Init components
  const sessionManager = new SessionManager(config, pool);
  await sessionManager.init();
  console.log("Session manager initialized");

  const rateLimiter = new RateLimiter(pool);
  await rateLimiter.init();
  console.log("Rate limiter initialized");

  const flowGuard = new FlowGuard(pool);
  await flowGuard.init();
  console.log("Flow guard initialized");

  const spawner = new AgentSpawner(config, pool, sessionManager);
  spawner.setRateLimiter(rateLimiter);

  // Cleanup stale sessions and process queue (every 5 minutes)
  setInterval(async () => {
    const cleaned = await sessionManager.cleanupStaleSessions();
    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} stale sessions`);
    }
    await rateLimiter.processQueue(spawner);
  }, 5 * 60 * 1000);

  // Routes
  app.use("/api/signal", createSignalRouter(config, pool, sessionManager, flowGuard, spawner, rateLimiter));
  app.use("/api", createWebhookRouter(config, spawner));

  // Agent spawning with rate limiting
  app.post("/api/spawn", async (req, res) => {
    const parsed = SpawnAgentInputSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid spawn payload",
        details: parsed.error.issues,
      });
      return;
    }

    const canSpawn = await rateLimiter.canSpawn();
    if (!canSpawn) {
      const position = await rateLimiter.enqueue(parsed.data);
      res.json({
        status: "queued",
        position,
        role: parsed.data.role,
        message: "Rate limit reached, task queued",
      });
      return;
    }

    try {
      const result = await spawner.spawn(parsed.data);
      res.json(result);
    } catch (err) {
      console.error("Spawn error:", err);
      res.status(500).json({ error: "Failed to spawn agent" });
    }
  });

  // Session management
  app.get("/api/sessions", async (req, res) => {
    const projectId = req.query.projectId as string | undefined;
    const sessions = await sessionManager.listSessions(projectId);
    res.json(sessions);
  });

  app.get("/api/sessions/:id", async (req, res) => {
    const session = await sessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(session);
  });

  app.delete("/api/sessions/:id", async (req, res) => {
    await sessionManager.terminateSession(req.params.id);
    res.json({ status: "terminated" });
  });

  // Queue management
  app.get("/api/queue", async (_req, res) => {
    const queue = await rateLimiter.getQueue();
    res.json(queue);
  });

  // Flow Guard audit
  app.get("/api/flow/audit", async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const log = await flowGuard.getAuditLog(limit);
    res.json(log);
  });

  app.get("/api/flow/violations", async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const violations = await flowGuard.getViolations(limit);
    res.json(violations);
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    server.close();
    await sessionManager.shutdownAll();
    await rateLimiter.reconcile();
    await pool.end();
    console.log("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const server = app.listen(config.port, () => {
    console.log(`Orchestra Core running on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error("Failed to start Orchestra Core:", err);
  process.exit(1);
});
