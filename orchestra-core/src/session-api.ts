import { Router } from "express";
import { z } from "zod";
import {
  getSession,
  getActiveSessions,
  terminateSession,
  updateHeartbeat,
} from "./session-manager.js";
import { spawnAgent } from "./agent-spawner.js";
import { loadConfig } from "./config.js";

export const sessionRouter: Router = Router();

// ─── List active sessions ───

sessionRouter.get("/sessions", async (req, res, next) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    const sessions = await getActiveSessions(projectId);
    res.json(sessions);
  } catch (e) { next(e); }
});

// ─── Get session by ID ───

sessionRouter.get("/sessions/:id", async (req, res, next) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json(session);
  } catch (e) { next(e); }
});

// ─── Spawn agent ───

sessionRouter.post("/sessions/spawn", async (req, res, next) => {
  try {
    const body = z.object({
      projectId: z.string().uuid(),
      taskId: z.string().uuid(),
      role: z.enum(["tech-lead", "designer", "frontend", "backend", "qa", "devops"]),
      resumeSessionId: z.string().optional(),
    }).parse(req.body);

    const config = loadConfig();

    const { session } = await spawnAgent({
      projectId: body.projectId,
      taskId: body.taskId,
      role: body.role,
      config,
      resumeSessionId: body.resumeSessionId,
    });

    res.status(201).json(session);
  } catch (e) {
    if (e instanceof Error && e.message.includes("blocked")) {
      return res.status(409).json({ error: e.message });
    }
    next(e);
  }
});

// ─── Terminate session ───

sessionRouter.post("/sessions/:id/terminate", async (req, res, next) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    // Kill the process if running
    if (session.pid) {
      try { process.kill(session.pid); } catch { /* already dead */ }
    }

    await terminateSession(session.id);
    res.json({ terminated: true });
  } catch (e) { next(e); }
});

// ─── Heartbeat (called by agents or monitoring) ───

sessionRouter.post("/sessions/:id/heartbeat", async (req, res, next) => {
  try {
    await updateHeartbeat(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
