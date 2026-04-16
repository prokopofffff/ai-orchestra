import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getPool } from "./db";
import { parseRow, parseRows } from "./db-utils";
import { dispatchTechLead } from "./tech-lead-dispatcher";
import { loadConfig } from "./config";
import { background } from "./error-handler";
import { MessageSchema, type Message as SharedMessage } from "@ai-orchestra/shared";

const messageSchema = MessageSchema;
export type Message = SharedMessage;

export const conversationPlugin: FastifyPluginAsync = async (app) => {
  // ─── Get messages for a project ───

  app.get<{ Params: { projectId: string } }>("/conversations/:projectId/messages", async (request, reply) => {
    const projectId = request.params.projectId;
    const query_ = request.query as Record<string, string>;
    const limit = Math.min(Number(query_.limit) || 50, 200);
    const before = query_.before;

    // Get conversation for project
    const { rows: convRows } = await getPool().query(
      "SELECT id FROM conversations WHERE project_id = $1",
      [projectId],
    );
    if (!convRows.length) return reply.code(404).send({ error: "No conversation for this project" });

    const convId = convRows[0].id;

    let query = "SELECT * FROM messages WHERE conversation_id = $1";
    const vals: unknown[] = [convId];

    if (before) {
      query += " AND created_at < $2";
      vals.push(before);
    }

    query += " ORDER BY created_at DESC LIMIT $" + (vals.length + 1);
    vals.push(limit);

    const { rows } = await getPool().query(query, vals);
    // Return in chronological order
    return parseRows(messageSchema, rows).reverse();
  });

  // ─── Send message from Dashboard ───

  app.post<{ Params: { projectId: string } }>("/conversations/:projectId/messages", async (request, reply) => {
    const projectId = request.params.projectId;
    const body = z.object({
      text: z.string().min(1),
      fromRole: z.enum(["user", "tech-lead", "system"]).default("user"),
      source: z.enum(["telegram", "dashboard"]).default("dashboard"),
      metadata: z.record(z.unknown()).optional(),
    }).parse(request.body);

    const { rows: convRows } = await getPool().query(
      "SELECT id FROM conversations WHERE project_id = $1",
      [projectId],
    );
    if (!convRows.length) return reply.code(404).send({ error: "No conversation for this project" });

    const convId = convRows[0].id;

    const { rows } = await getPool().query(
      `INSERT INTO messages (conversation_id, from_role, source, text, metadata)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [convId, body.fromRole, body.source, body.text, JSON.stringify(body.metadata ?? {})],
    );

    const message = parseRow(messageSchema, rows[0]);

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
  const pool = getPool();

  const { rows: convRows } = await pool.query(
    "SELECT id FROM conversations WHERE project_id = $1",
    [projectId],
  );
  if (!convRows.length) return null;

  const { rows } = await pool.query(
    `INSERT INTO messages (conversation_id, from_role, source, text, metadata)
     VALUES ($1, 'system', 'dashboard', $2, $3) RETURNING *`,
    [convRows[0].id, text, JSON.stringify(metadata ?? {})],
  );

  return parseRow(messageSchema, rows[0]);
}

// ─── Helper: add Tech Lead message ───

export async function addTechLeadMessage(
  projectId: string,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<Message | null> {
  const pool = getPool();

  const { rows: convRows } = await pool.query(
    "SELECT id FROM conversations WHERE project_id = $1",
    [projectId],
  );
  if (!convRows.length) return null;

  const { rows } = await pool.query(
    `INSERT INTO messages (conversation_id, from_role, source, text, metadata)
     VALUES ($1, 'tech-lead', 'dashboard', $2, $3) RETURNING *`,
    [convRows[0].id, text, JSON.stringify(metadata ?? {})],
  );

  return parseRow(messageSchema, rows[0]);
}
