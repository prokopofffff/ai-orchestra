import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, desc, eq, lt } from "drizzle-orm";
import { getDb } from "./db";
import { conversations, messages } from "./db/schema";
import { parseRow, parseRows } from "./db-utils";
import { dispatchTechLead } from "./tech-lead-dispatcher";
import { loadConfig } from "./config";
import { background } from "./error-handler";
import { MessageSchema, type Message as SharedMessage } from "@ai-orchestra/shared";
import { currentUserId } from "./auth";
import { userCanAccessProject, userCanEditProject } from "./project-access";

const messageSchema = MessageSchema;
export type Message = SharedMessage;

async function conversationIdFor(projectId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.projectId, projectId))
    .limit(1);
  return row?.id ?? null;
}

export const conversationPlugin: FastifyPluginAsync = async (app) => {
  // ─── Get messages for a project ───

  app.get<{ Params: { projectId: string } }>("/conversations/:projectId/messages", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.params.projectId;
    if (!(await userCanAccessProject(userId, projectId))) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const query_ = request.query as Record<string, string>;
    const limit = Math.min(Number(query_.limit) || 50, 200);
    const before = query_.before;

    const convId = await conversationIdFor(projectId);
    if (!convId) return reply.code(404).send({ error: "No conversation for this project" });

    const conds = [eq(messages.conversationId, convId)];
    if (before) conds.push(lt(messages.createdAt, new Date(before)));

    const rows = await getDb()
      .select()
      .from(messages)
      .where(and(...conds))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return parseRows(messageSchema, rows).reverse();
  });

  // ─── Send message from Dashboard ───

  app.post<{ Params: { projectId: string } }>("/conversations/:projectId/messages", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.params.projectId;
    if (!(await userCanEditProject(userId, projectId))) {
      return reply.code(403).send({ error: "Insufficient permissions on project" });
    }
    const body = z.object({
      text: z.string().min(1),
      fromRole: z.enum(["user", "tech-lead", "system"]).default("user"),
      source: z.enum(["telegram", "dashboard"]).default("dashboard"),
      metadata: z.record(z.unknown()).optional(),
    }).parse(request.body);

    const convId = await conversationIdFor(projectId);
    if (!convId) return reply.code(404).send({ error: "No conversation for this project" });

    const [row] = await getDb()
      .insert(messages)
      .values({
        conversationId: convId,
        fromRole: body.fromRole,
        source: body.source,
        text: body.text,
        metadata: body.metadata ?? {},
      })
      .returning();

    const message = parseRow(messageSchema, row);

    // Dispatch Tech Lead when user sends a message
    if (body.fromRole === "user") {
      const config = loadConfig();
      background(dispatchTechLead(projectId, body.text, config), "conversation:dispatch", projectId);
    }

    return reply.code(201).send(message);
  });
};

// ─── Helper: add system message (used internally) ───

export async function addSystemMessage(
  projectId: string,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<Message | null> {
  const convId = await conversationIdFor(projectId);
  if (!convId) return null;

  const [row] = await getDb()
    .insert(messages)
    .values({
      conversationId: convId,
      fromRole: "system",
      source: "dashboard",
      text,
      metadata: metadata ?? {},
    })
    .returning();
  return parseRow(messageSchema, row);
}

// ─── Helper: add Tech Lead message ───

export async function addTechLeadMessage(
  projectId: string,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<Message | null> {
  const convId = await conversationIdFor(projectId);
  if (!convId) return null;

  const [row] = await getDb()
    .insert(messages)
    .values({
      conversationId: convId,
      fromRole: "tech-lead",
      source: "dashboard",
      text,
      metadata: metadata ?? {},
    })
    .returning();
  return parseRow(messageSchema, row);
}
