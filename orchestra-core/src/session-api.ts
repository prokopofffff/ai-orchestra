import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  getSession,
  getActiveSessions,
  terminateSession,
  updateHeartbeat,
} from "./session-manager";
import { spawnAgent } from "./agent-spawner";
import { loadConfig } from "./config";

export const sessionPlugin: FastifyPluginAsync = async (app) => {
  // ─── List active sessions ───

  app.get("/sessions", async (request) => {
    const projectId = (request.query as Record<string, string>).projectId;
    const sessions = await getActiveSessions(projectId);
    return sessions;
  });

  // ─── Get session by ID ───

  app.get<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    return session;
  });

  // ─── Spawn agent ───

  app.post("/sessions/spawn", async (request, reply) => {
    const body = z.object({
      projectId: z.string().uuid(),
      taskId: z.string().uuid(),
      role: z.enum(["tech-lead", "designer", "frontend", "backend", "qa", "devops"]),
      resumeSessionId: z.string().optional(),
    }).parse(request.body);

    const config = loadConfig();

    try {
      const { session } = await spawnAgent({
        projectId: body.projectId,
        taskId: body.taskId,
        role: body.role,
        config,
        resumeSessionId: body.resumeSessionId,
      });

      return reply.code(201).send(session);
    } catch (e) {
      if (e instanceof Error && e.message.includes("blocked")) {
        return reply.code(409).send({ error: e.message });
      }
      throw e;
    }
  });

  // ─── Terminate session ───

  app.post<{ Params: { id: string } }>("/sessions/:id/terminate", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });

    // Mid-flight SDK runs can't be killed via PID (they're in-process).
    // Marking the session terminated stops it being treated as active; the
    // worker handler completes in the background and the scheduler lease
    // expires naturally. Future: track active queries and call .interrupt().
    await terminateSession(session.id);
    return { terminated: true };
  });

  // ─── Heartbeat (called by agents or monitoring) ───

  app.post<{ Params: { id: string } }>("/sessions/:id/heartbeat", async (request) => {
    await updateHeartbeat(request.params.id);
    return { ok: true };
  });
};
