import { Router } from "express";
import { z } from "zod";
import { ProjectSchema, TaskSchema, TaskCommentSchema } from "@ai-orchestra/shared";
import { getPool } from "./db";
import { parseRow, parseRows } from "./db-utils";
import { checkUnblocked } from "./dependency-engine";
import { canCreateTask, canUpdateTask, canDeleteTask } from "./agent-auth";
import type { AgentRole } from "./config";

export const taskRouter: Router = Router();

// Aliases to keep existing call-site naming.
const projectSchema = ProjectSchema;
const taskSchema = TaskSchema;
const commentSchema = TaskCommentSchema;

// ─── Projects ───

taskRouter.get("/projects", async (_req, res, next) => {
  try {
    const { rows } = await getPool().query("SELECT * FROM projects ORDER BY created_at DESC");
    res.json(parseRows(projectSchema, rows));
  } catch (e) { next(e); }
});

taskRouter.post("/projects", async (req, res, next) => {
  try {
    const body = z.object({
      name: z.string().min(1),
      slug: z.string().min(1).optional(),
      repoUrl: z.string().optional(),
      description: z.string().optional(),
    }).parse(req.body);

    const slug = body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const { rows } = await getPool().query(
      `INSERT INTO projects (name, slug, repo_url, description)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [body.name, slug, body.repoUrl ?? null, body.description ?? null],
    );

    // Create conversation for the project
    await getPool().query(
      "INSERT INTO conversations (project_id) VALUES ($1)",
      [rows[0].id],
    );

    res.status(201).json(parseRow(projectSchema, rows[0]));
  } catch (e) { next(e); }
});

taskRouter.get("/projects/:id", async (req, res, next) => {
  try {
    const { rows } = await getPool().query("SELECT * FROM projects WHERE id = $1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Project not found" });
    res.json(parseRow(projectSchema, rows[0]));
  } catch (e) { next(e); }
});

taskRouter.patch("/projects/:id", async (req, res, next) => {
  try {
    const body = z.object({
      name: z.string().optional(),
      repoUrl: z.string().optional(),
      description: z.string().optional(),
      settings: z.record(z.unknown()).optional(),
    }).parse(req.body);

    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;

    if (body.name !== undefined) { sets.push(`name = $${i++}`); vals.push(body.name); }
    if (body.repoUrl !== undefined) { sets.push(`repo_url = $${i++}`); vals.push(body.repoUrl); }
    if (body.description !== undefined) { sets.push(`description = $${i++}`); vals.push(body.description); }
    if (body.settings !== undefined) { sets.push(`settings = settings || $${i++}::jsonb`); vals.push(JSON.stringify(body.settings)); }

    if (!sets.length) return res.status(400).json({ error: "No fields to update" });

    sets.push(`updated_at = now()`);
    vals.push(req.params.id);

    const { rows } = await getPool().query(
      `UPDATE projects SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals,
    );
    if (!rows.length) return res.status(404).json({ error: "Project not found" });
    res.json(parseRow(projectSchema, rows[0]));
  } catch (e) { next(e); }
});

// ─── Tasks ───

taskRouter.get("/tasks", async (req, res, next) => {
  try {
    const filters = z.object({
      projectId: z.string().uuid().optional(),
      state: z.string().optional(),
      type: z.string().optional(),
      assigneeRole: z.string().optional(),
    }).parse(req.query);

    const wheres: string[] = [];
    const vals: unknown[] = [];
    let i = 1;

    if (filters.projectId) { wheres.push(`project_id = $${i++}`); vals.push(filters.projectId); }
    if (filters.state) { wheres.push(`state = $${i++}`); vals.push(filters.state); }
    if (filters.type) { wheres.push(`type = $${i++}`); vals.push(filters.type); }
    if (filters.assigneeRole) { wheres.push(`assignee_role = $${i++}`); vals.push(filters.assigneeRole); }

    const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
    const { rows } = await getPool().query(`SELECT * FROM tasks ${where} ORDER BY created_at DESC`, vals);
    res.json(parseRows(taskSchema, rows));
  } catch (e) { next(e); }
});

taskRouter.post("/tasks", async (req, res, next) => {
  try {
    // Validate agent permission to create tasks
    const agentRole = req.headers["x-agent-role"] as string | undefined;
    if (agentRole) {
      const check = canCreateTask(agentRole as AgentRole);
      if (!check.allowed) return res.status(403).json({ error: check.reason });
    }

    const body = z.object({
      projectId: z.string().uuid(),
      parentId: z.string().uuid().optional(),
      title: z.string().min(1),
      description: z.string().optional(),
      type: z.enum(["epic", "task", "subtask", "bug", "feature"]).default("task"),
      state: z.string().default("new"),
      priority: z.enum(["low", "normal", "high", "immediate"]).default("normal"),
      assigneeRole: z.string().optional(),
      blockedBy: z.array(z.string().uuid()).default([]),
    }).parse(req.body);

    const { rows } = await getPool().query(
      `INSERT INTO tasks (project_id, parent_id, title, description, type, state, priority, assignee_role, blocked_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        body.projectId, body.parentId ?? null, body.title, body.description ?? null,
        body.type, body.state, body.priority, body.assigneeRole ?? null, body.blockedBy,
      ],
    );
    res.status(201).json(parseRow(taskSchema, rows[0]));
  } catch (e) { next(e); }
});

taskRouter.get("/tasks/:id", async (req, res, next) => {
  try {
    const { rows } = await getPool().query("SELECT * FROM tasks WHERE id = $1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Task not found" });
    res.json(parseRow(taskSchema, rows[0]));
  } catch (e) { next(e); }
});

taskRouter.patch("/tasks/:id", async (req, res, next) => {
  try {
    // Validate agent permission to update this task
    const agentRole = req.headers["x-agent-role"] as string | undefined;
    if (agentRole) {
      const { rows: taskRows } = await getPool().query(
        "SELECT assignee_role FROM tasks WHERE id = $1",
        [req.params.id],
      );
      const check = canUpdateTask(
        agentRole as AgentRole,
        (taskRows[0]?.assignee_role as string) ?? null,
        req.body,
      );
      if (!check.allowed) return res.status(403).json({ error: check.reason });
    }

    const body = z.object({
      title: z.string().optional(),
      description: z.string().optional(),
      type: z.enum(["epic", "task", "subtask", "bug", "feature"]).optional(),
      state: z.string().optional(),
      priority: z.enum(["low", "normal", "high", "immediate"]).optional(),
      assigneeRole: z.string().nullable().optional(),
      blockedBy: z.array(z.string().uuid()).optional(),
      branchName: z.string().nullable().optional(),
      prUrl: z.string().nullable().optional(),
    }).parse(req.body);

    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;

    if (body.title !== undefined) { sets.push(`title = $${i++}`); vals.push(body.title); }
    if (body.description !== undefined) { sets.push(`description = $${i++}`); vals.push(body.description); }
    if (body.type !== undefined) { sets.push(`type = $${i++}`); vals.push(body.type); }
    if (body.state !== undefined) { sets.push(`state = $${i++}`); vals.push(body.state); }
    if (body.priority !== undefined) { sets.push(`priority = $${i++}`); vals.push(body.priority); }
    if (body.assigneeRole !== undefined) { sets.push(`assignee_role = $${i++}`); vals.push(body.assigneeRole); }
    if (body.blockedBy !== undefined) { sets.push(`blocked_by = $${i++}`); vals.push(body.blockedBy); }
    if (body.branchName !== undefined) { sets.push(`branch_name = $${i++}`); vals.push(body.branchName); }
    if (body.prUrl !== undefined) { sets.push(`pr_url = $${i++}`); vals.push(body.prUrl); }

    if (!sets.length) return res.status(400).json({ error: "No fields to update" });

    sets.push(`updated_at = now()`);
    vals.push(req.params.id);

    const { rows } = await getPool().query(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals,
    );
    if (!rows.length) return res.status(404).json({ error: "Task not found" });

    // Check if this state change unblocks other tasks
    const parsed = parseRow(taskSchema, rows[0]);
    const doneStates = ["tested", "approved", "merged", "closed", "design_ready"];
    if (body.state && doneStates.includes(body.state)) {
      const unblocked = await checkUnblocked(parsed.id, parsed.projectId);
      if (unblocked.length > 0) {
        (parsed as Record<string, unknown>).unblockedTasks = unblocked;
      }
    }

    res.json(parsed);
  } catch (e) { next(e); }
});

taskRouter.delete("/tasks/:id", async (req, res, next) => {
  try {
    const agentRole = req.headers["x-agent-role"] as string | undefined;
    if (agentRole) {
      const check = canDeleteTask(agentRole as AgentRole);
      if (!check.allowed) return res.status(403).json({ error: check.reason });
    }

    const { rowCount } = await getPool().query("DELETE FROM tasks WHERE id = $1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "Task not found" });
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

// ─── Task Comments ───

taskRouter.get("/tasks/:id/comments", async (req, res, next) => {
  try {
    const { rows } = await getPool().query(
      "SELECT * FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC",
      [req.params.id],
    );
    res.json(parseRows(commentSchema, rows));
  } catch (e) { next(e); }
});

taskRouter.post("/tasks/:id/comments", async (req, res, next) => {
  try {
    const body = z.object({
      author: z.string().min(1),
      body: z.string().min(1),
    }).parse(req.body);

    const { rows } = await getPool().query(
      "INSERT INTO task_comments (task_id, author, body) VALUES ($1, $2, $3) RETURNING *",
      [req.params.id, body.author, body.body],
    );
    res.status(201).json(parseRow(commentSchema, rows[0]));
  } catch (e) { next(e); }
});
