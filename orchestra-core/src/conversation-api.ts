import { Router } from "express";
import { z } from "zod";
import { getPool } from "./db.js";
import { parseRow, parseRows } from "./db-utils.js";
import { dispatchTechLead } from "./tech-lead-dispatcher.js";
import { loadConfig } from "./config.js";
import { background } from "./error-handler.js";

export const conversationRouter: Router = Router();

const messageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  fromRole: z.string(),
  source: z.string(),
  text: z.string(),
  metadata: z.record(z.unknown()),
  createdAt: z.coerce.date(),
});

export type Message = z.infer<typeof messageSchema>;

// ─── Get messages for a project ───

conversationRouter.get("/conversations/:projectId/messages", async (req, res, next) => {
  try {
    const projectId = req.params.projectId;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const before = req.query.before as string | undefined;

    // Get conversation for project
    const { rows: convRows } = await getPool().query(
      "SELECT id FROM conversations WHERE project_id = $1",
      [projectId],
    );
    if (!convRows.length) return res.status(404).json({ error: "No conversation for this project" });

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
    res.json(parseRows(messageSchema, rows).reverse());
  } catch (e) { next(e); }
});

// ─── Send message from Dashboard ───

conversationRouter.post("/conversations/:projectId/messages", async (req, res, next) => {
  try {
    const projectId = req.params.projectId;
    const body = z.object({
      text: z.string().min(1),
      fromRole: z.enum(["user", "tech-lead", "system"]).default("user"),
      source: z.enum(["telegram", "dashboard"]).default("dashboard"),
      metadata: z.record(z.unknown()).optional(),
    }).parse(req.body);

    const { rows: convRows } = await getPool().query(
      "SELECT id FROM conversations WHERE project_id = $1",
      [projectId],
    );
    if (!convRows.length) return res.status(404).json({ error: "No conversation for this project" });

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

    res.status(201).json(message);
  } catch (e) { next(e); }
});

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
