import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, desc, inArray } from "drizzle-orm";
import {
  getSession,
  terminateSession,
  updateHeartbeat,
} from "./session-manager";
import { spawnAgent } from "./agent-spawner";
import { loadConfig } from "./config";
import { getDb } from "./db";
import { sessions as sessionsTable } from "./db/schema";
import { parseRows } from "./db-utils";
import { AgentSessionSchema } from "@ai-orchestra/shared";
import { currentUserId, authorizeProject } from "./auth";
import { userCanAccessProject, userCanEditProject, visibleProjectIds } from "./project-access";

export const sessionPlugin: FastifyPluginAsync = async (app) => {
  // ─── List active sessions ───

  app.get("/sessions", async (request, reply) => {
    const userId = currentUserId(request);
    const q = (request.query as Record<string, string>).projectId;
    if (q && !(await userCanAccessProject(userId, q))) {
      return reply.code(404).send({ error: "Проект не найден" });
    }
    const visible = q ? [q] : await visibleProjectIds(userId);
    if (!visible.length) return [];
    const rows = await getDb()
      .select()
      .from(sessionsTable)
      .where(and(
        inArray(sessionsTable.projectId, visible),
        inArray(sessionsTable.status, ["running", "sleeping"]),
      ))
      .orderBy(desc(sessionsTable.startedAt));
    return parseRows(AgentSessionSchema, rows);
  });

  // ─── Get session by ID ───

  app.get<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const userId = currentUserId(request);
    const session = await getSession(request.params.id);
    if (!session || !(await userCanAccessProject(userId, session.projectId))) {
      return reply.code(404).send({ error: "Сессия не найдена" });
    }
    return session;
  });

  // ─── Spawn agent ───

  app.post("/sessions/spawn", async (request, reply) => {
    const userId = currentUserId(request);
    const body = z.object({
      projectId: z.string().uuid(),
      taskId: z.string().uuid(),
      role: z.enum(["tech-lead", "designer", "frontend", "backend", "qa", "devops"]),
      resumeSessionId: z.string().optional(),
    }).parse(request.body);

    if (!(await userCanEditProject(userId, body.projectId))) {
      return reply.code(403).send({ error: "Недостаточно прав доступа к проекту" });
    }

    const config = loadConfig();

    try {
      const { session, skipped } = await spawnAgent({
        projectId: body.projectId,
        taskId: body.taskId,
        role: body.role,
        config,
        resumeSessionId: body.resumeSessionId,
      });

      // Atomic spawn guard rejected it (role already running / at cap).
      if (!session) {
        return reply.code(409).send({ error: skipped?.detail ?? "Агент уже запущен" });
      }
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
    const userId = currentUserId(request);
    const session = await getSession(request.params.id);
    if (!session || !(await userCanAccessProject(userId, session.projectId))) {
      return reply.code(404).send({ error: "Сессия не найдена" });
    }
    if (!(await userCanEditProject(userId, session.projectId))) {
      return reply.code(403).send({ error: "Недостаточно прав" });
    }

    // Mid-flight SDK runs can't be killed via PID (they're in-process).
    // Marking the session terminated stops it being treated as active; the
    // worker handler completes in the background and the scheduler lease
    // expires naturally. Future: track active queries and call .interrupt().
    await terminateSession(session.id);
    return { terminated: true };
  });

  // ─── Heartbeat (called by agents or monitoring) ───

  app.post<{ Params: { id: string } }>("/sessions/:id/heartbeat", async (request, reply) => {
    // Heartbeats are agent-internal; a signed agent token (kind:"agent")
    // bypasses the user membership check, but only for the project it was
    // minted for — never on the basis of a client-supplied header.
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "Сессия не найдена" });
    const authz = await authorizeProject(request, session.projectId, "access");
    if (!authz.ok) return reply.code(404).send({ error: "Сессия не найдена" });
    await updateHeartbeat(request.params.id);
    return { ok: true };
  });
};
