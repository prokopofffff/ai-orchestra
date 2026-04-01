import "dotenv/config";
import express from "express";
import { loadConfig } from "./config.js";
import { waitForDatabase, runMigrations, getPool } from "./db.js";
import { taskRouter } from "./task-api.js";
import { signalRouter } from "./signal-api.js";
import { sessionRouter } from "./session-api.js";
import { conversationRouter } from "./conversation-api.js";
import { webhookRouter } from "./webhooks.js";
import { startHeartbeat, stopHeartbeat } from "./heartbeat.js";
import { reconcileQueue, getQueueStatus } from "./rate-limiter.js";
import { startUsageTracking, stopUsageTracking, getUsage } from "./usage-tracker.js";
import { getLogs } from "./logger.js";
import { startTelegramPolling, stopTelegramPolling } from "./telegram-polling.js";

async function main() {
  const config = loadConfig();
  const app = express();

  app.use(express.json());

  // ─── Health check ───
  app.get("/api/health", async (_req, res) => {
    try {
      await getPool().query("SELECT 1");
      res.json({ status: "ok", timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: "unhealthy" });
    }
  });

  // ─── Queue status ───
  app.get("/api/queue/status", async (_req, res, next) => {
    try {
      const status = await getQueueStatus();
      res.json(status);
    } catch (e) { next(e); }
  });

  // ─── Usage ───
  app.get("/api/usage", (_req, res) => {
    res.json(getUsage());
  });

  // ─── Agent Logs ───
  app.get("/api/logs", async (req, res, next) => {
    try {
      const projectId = req.query.projectId as string;
      if (!projectId) return res.status(400).json({ error: "projectId required" });
      const logs = await getLogs(projectId, {
        sessionId: req.query.sessionId as string | undefined,
        role: req.query.role as string | undefined,
        level: req.query.level as "stdout" | "stderr" | "system" | "error" | undefined,
        limit: Number(req.query.limit) || 200,
      });
      res.json(logs);
    } catch (e) { next(e); }
  });

  // ─── API routes ───
  app.use("/api", taskRouter);
  app.use("/api", signalRouter);
  app.use("/api", sessionRouter);
  app.use("/api", conversationRouter);
  app.use("/api", webhookRouter);

  // ─── Static dashboard ───
  app.use(express.static(config.dashboardPath));
  // SPA fallback — serve index.html for non-API routes
  app.get("*", (_req, res, next) => {
    if (_req.path.startsWith("/api")) return next();
    res.sendFile("index.html", { root: config.dashboardPath });
  });

  // ─── Error handler ───
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Unhandled error:", err.message);
    if (err.name === "ZodError") {
      return res.status(400).json({ error: "Validation error", details: err });
    }
    res.status(500).json({ error: "Internal server error" });
  });

  // ─── Startup ───
  console.log("Waiting for database...");
  await waitForDatabase(config.databaseUrl);

  console.log("Running migrations...");
  await runMigrations(config.databaseUrl);

  // Create first project if configured
  await createFirstProject();

  // Reconcile queue (items stuck as 'running' after restart)
  await reconcileQueue();

  // Start heartbeat monitor
  startHeartbeat();

  // Start usage tracking
  startUsageTracking();

  // Start Telegram polling (for local dev — in production use webhook)
  startTelegramPolling();

  const server = app.listen(config.port, () => {
    console.log(`Orchestra-core running on port ${config.port}`);
    console.log(`Telegram: ${config.telegramBotToken ? "enabled" : "disabled"}`);
    console.log(`GitHub: ${config.githubToken ? "enabled" : "disabled"}`);
  });

  // ─── Graceful shutdown ───
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);

    stopHeartbeat();
    stopUsageTracking();
    stopTelegramPolling();

    server.close();

    // Mark all running sessions as sleeping (they can be resumed)
    try {
      const pool = getPool();
      const { rowCount } = await pool.query(
        "UPDATE sessions SET status = 'sleeping' WHERE status = 'running'",
      );
      if (rowCount) console.log(`Marked ${rowCount} session(s) as sleeping`);
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
  console.log(`Created first project: ${name} (${created[0].id})`);
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
