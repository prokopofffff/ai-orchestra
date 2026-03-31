import { Router, Request, Response } from "express";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { TaskStateSchema } from "./flow-guard.js";

export const TaskTypeSchema = z.enum(["Epic", "Task", "Subtask", "Bug", "Feature"]);
export const TaskPrioritySchema = z.enum(["Low", "Normal", "High", "Immediate"]);

export const CreateTaskSchema = z.object({
  projectId: z.string().min(1),
  subject: z.string().min(1),
  description: z.string().optional(),
  type: TaskTypeSchema.default("Task"),
  priority: TaskPrioritySchema.default("Normal"),
  parentId: z.string().optional(),
  assignee: z.string().optional(),
});

export const UpdateTaskSchema = z.object({
  subject: z.string().min(1).optional(),
  description: z.string().optional(),
  type: TaskTypeSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  state: TaskStateSchema.optional(),
  assignee: z.string().nullable().optional(),
  doneRatio: z.number().min(0).max(100).optional(),
});

export const CreateProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

export const AddCommentSchema = z.object({
  author: z.string().min(1),
  comment: z.string().min(1),
});

export interface TaskRecord {
  id: string;
  projectId: string;
  subject: string;
  description: string;
  type: string;
  priority: string;
  state: string;
  parentId: string | null;
  assignee: string | null;
  doneRatio: number;
  createdAt: string;
  updatedAt: string;
}

export async function initTaskTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      subject TEXT NOT NULL,
      description TEXT DEFAULT '',
      type TEXT NOT NULL DEFAULT 'Task',
      priority TEXT NOT NULL DEFAULT 'Normal',
      state TEXT NOT NULL DEFAULT 'new',
      parent_id TEXT,
      assignee TEXT,
      done_ratio INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      comment TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

export function createTaskRouter(pool: Pool): Router {
  const router = Router();

  // --- Projects ---

  router.get("/projects", async (_req: Request, res: Response) => {
    const result = await pool.query(
      `SELECT * FROM projects ORDER BY created_at DESC`
    );
    res.json(result.rows);
  });

  router.post("/projects", async (req: Request, res: Response) => {
    const parsed = CreateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid project", details: parsed.error.issues });
      return;
    }

    const id = uuidv4();
    await pool.query(
      `INSERT INTO projects (id, name, description) VALUES ($1, $2, $3)`,
      [id, parsed.data.name, parsed.data.description || ""]
    );

    res.json({ id, name: parsed.data.name });
  });

  // --- Tasks ---

  router.get("/tasks", async (req: Request, res: Response) => {
    const { project, state, type } = req.query;

    let query = `SELECT * FROM tasks WHERE 1=1`;
    const params: unknown[] = [];
    let idx = 1;

    if (project) {
      query += ` AND project_id = $${idx++}`;
      params.push(project);
    }
    if (state) {
      query += ` AND state = $${idx++}`;
      params.push(state);
    }
    if (type) {
      query += ` AND type = $${idx++}`;
      params.push(type);
    }

    query += ` ORDER BY CASE priority WHEN 'Immediate' THEN 0 WHEN 'High' THEN 1 WHEN 'Normal' THEN 2 WHEN 'Low' THEN 3 END, created_at DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  });

  router.get("/tasks/:id", async (req: Request, res: Response) => {
    const result = await pool.query(`SELECT * FROM tasks WHERE id = $1`, [req.params.id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(result.rows[0]);
  });

  router.post("/tasks", async (req: Request, res: Response) => {
    const parsed = CreateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid task", details: parsed.error.issues });
      return;
    }

    // Verify project exists
    const project = await pool.query(`SELECT id FROM projects WHERE id = $1`, [parsed.data.projectId]);
    if (project.rows.length === 0) {
      res.status(400).json({ error: `Project ${parsed.data.projectId} not found` });
      return;
    }

    const id = uuidv4();
    const d = parsed.data;

    await pool.query(
      `INSERT INTO tasks (id, project_id, subject, description, type, priority, parent_id, assignee)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, d.projectId, d.subject, d.description || "", d.type, d.priority, d.parentId || null, d.assignee || null]
    );

    const result = await pool.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
    res.json(result.rows[0]);
  });

  router.patch("/tasks/:id", async (req: Request, res: Response) => {
    const parsed = UpdateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid update", details: parsed.error.issues });
      return;
    }

    const updates: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    const fields: Record<string, string> = {
      subject: "subject",
      description: "description",
      type: "type",
      priority: "priority",
      state: "state",
      assignee: "assignee",
      doneRatio: "done_ratio",
    };

    for (const [key, col] of Object.entries(fields)) {
      const value = parsed.data[key as keyof typeof parsed.data];
      if (value !== undefined) {
        updates.push(`${col} = $${idx++}`);
        params.push(value);
      }
    }

    if (updates.length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    updates.push(`updated_at = NOW()`);
    params.push(req.params.id);

    await pool.query(
      `UPDATE tasks SET ${updates.join(", ")} WHERE id = $${idx}`,
      params
    );

    const result = await pool.query(`SELECT * FROM tasks WHERE id = $1`, [req.params.id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(result.rows[0]);
  });

  router.delete("/tasks/:id", async (req: Request, res: Response) => {
    const result = await pool.query(
      `DELETE FROM tasks WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if ((result.rowCount || 0) === 0) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json({ deleted: true, id: req.params.id });
  });

  // --- Comments ---

  router.get("/tasks/:id/comments", async (req: Request, res: Response) => {
    const result = await pool.query(
      `SELECT * FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json(result.rows);
  });

  router.post("/tasks/:id/comments", async (req: Request, res: Response) => {
    const parsed = AddCommentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid comment", details: parsed.error.issues });
      return;
    }

    // Verify task exists
    const task = await pool.query(`SELECT id FROM tasks WHERE id = $1`, [req.params.id]);
    if (task.rows.length === 0) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const id = uuidv4();
    await pool.query(
      `INSERT INTO task_comments (id, task_id, author, comment) VALUES ($1, $2, $3, $4)`,
      [id, req.params.id, parsed.data.author, parsed.data.comment]
    );

    res.json({ id, taskId: req.params.id, author: parsed.data.author });
  });

  return router;
}
