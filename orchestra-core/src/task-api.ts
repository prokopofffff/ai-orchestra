import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ProjectSchema, TaskSchema, TaskCommentSchema } from "@ai-orchestra/shared";
import { getPool } from "./db";
import { parseRow, parseRows } from "./db-utils";
import { checkUnblocked } from "./dependency-engine";
import { canCreateTask, canUpdateTask, canDeleteTask } from "./agent-auth";
import type { AgentRole } from "./config";

const projectSchema = ProjectSchema;
const taskSchema = TaskSchema;
const commentSchema = TaskCommentSchema;

export const taskPlugin: FastifyPluginAsync = async (app) => {
  // ─── Projects ───

  app.get("/projects", async () => {
    const { rows } = await getPool().query("SELECT * FROM projects ORDER BY created_at DESC");
    return parseRows(projectSchema, rows);
  });

  app.post("/projects", async (request, reply) => {
    const body = z.object({
      name: z.string().min(1),
      slug: z.string().min(1).optional(),
      repoUrl: z.string().optional(),
      description: z.string().optional(),
    }).parse(request.body);

    const slug = body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const { rows } = await getPool().query(
      `INSERT INTO projects (name, slug, repo_url, description)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [body.name, slug, body.repoUrl ?? null, body.description ?? null],
    );

    await getPool().query("INSERT INTO conversations (project_id) VALUES ($1)", [rows[0].id]);
    return reply.code(201).send(parseRow(projectSchema, rows[0]));
  });

  app.get<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    const { rows } = await getPool().query("SELECT * FROM projects WHERE id = $1", [request.params.id]);
    if (!rows.length) return reply.code(404).send({ error: "Project not found" });
    return parseRow(projectSchema, rows[0]);
  });

  app.patch<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    const body = z.object({
      name: z.string().optional(),
      repoUrl: z.string().optional(),
      description: z.string().optional(),
      settings: z.record(z.unknown()).optional(),
    }).parse(request.body);

    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;

    if (body.name !== undefined) { sets.push(`name = $${i++}`); vals.push(body.name); }
    if (body.repoUrl !== undefined) { sets.push(`repo_url = $${i++}`); vals.push(body.repoUrl); }
    if (body.description !== undefined) { sets.push(`description = $${i++}`); vals.push(body.description); }
    if (body.settings !== undefined) { sets.push(`settings = settings || $${i++}::jsonb`); vals.push(JSON.stringify(body.settings)); }

    if (!sets.length) return reply.code(400).send({ error: "No fields to update" });

    sets.push(`updated_at = now()`);
    vals.push(request.params.id);

    const { rows } = await getPool().query(
      `UPDATE projects SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals,
    );
    if (!rows.length) return reply.code(404).send({ error: "Project not found" });
    return parseRow(projectSchema, rows[0]);
  });

  // ─── Tasks ───

  app.get("/tasks", async (request) => {
    const query = request.query as Record<string, string>;
    const filters = z.object({
      projectId: z.string().uuid().optional(),
      state: z.string().optional(),
      type: z.string().optional(),
      assigneeRole: z.string().optional(),
    }).parse(query);

    const wheres: string[] = [];
    const vals: unknown[] = [];
    let i = 1;

    if (filters.projectId) { wheres.push(`project_id = $${i++}`); vals.push(filters.projectId); }
    if (filters.state) { wheres.push(`state = $${i++}`); vals.push(filters.state); }
    if (filters.type) { wheres.push(`type = $${i++}`); vals.push(filters.type); }
    if (filters.assigneeRole) { wheres.push(`assignee_role = $${i++}`); vals.push(filters.assigneeRole); } // eslint-disable-line no-useless-assignment

    const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
    const { rows } = await getPool().query(`SELECT * FROM tasks ${where} ORDER BY created_at DESC`, vals);
    return parseRows(taskSchema, rows);
  });

  app.post("/tasks", async (request, reply) => {
    const agentRole = request.headers["x-agent-role"] as string | undefined;
    if (agentRole) {
      const check = canCreateTask(agentRole as AgentRole);
      if (!check.allowed) return reply.code(403).send({ error: check.reason });
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
    }).parse(request.body);

    const { rows } = await getPool().query(
      `INSERT INTO tasks (project_id, parent_id, title, description, type, state, priority, assignee_role, blocked_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        body.projectId, body.parentId ?? null, body.title, body.description ?? null,
        body.type, body.state, body.priority, body.assigneeRole ?? null, body.blockedBy,
      ],
    );
    return reply.code(201).send(parseRow(taskSchema, rows[0]));
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const { rows } = await getPool().query("SELECT * FROM tasks WHERE id = $1", [request.params.id]);
    if (!rows.length) return reply.code(404).send({ error: "Task not found" });
    return parseRow(taskSchema, rows[0]);
  });

  app.patch<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const agentRole = request.headers["x-agent-role"] as string | undefined;
    if (agentRole) {
      const { rows: taskRows } = await getPool().query(
        "SELECT assignee_role FROM tasks WHERE id = $1",
        [request.params.id],
      );
      const check = canUpdateTask(
        agentRole as AgentRole,
        (taskRows[0]?.assignee_role as string) ?? null,
        request.body as { state?: string },
      );
      if (!check.allowed) return reply.code(403).send({ error: check.reason });
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
    }).parse(request.body);

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

    if (!sets.length) return reply.code(400).send({ error: "No fields to update" });

    sets.push(`updated_at = now()`);
    vals.push(request.params.id);

    const { rows } = await getPool().query(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals,
    );
    if (!rows.length) return reply.code(404).send({ error: "Task not found" });

    const parsed = parseRow(taskSchema, rows[0]);
    const doneStates = ["tested", "approved", "merged", "closed", "design_ready"];
    if (body.state && doneStates.includes(body.state)) {
      const unblocked = await checkUnblocked(parsed.id, parsed.projectId);
      if (unblocked.length > 0) {
        (parsed as Record<string, unknown>).unblockedTasks = unblocked;
      }
    }

    return parsed;
  });

  app.delete<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const agentRole = request.headers["x-agent-role"] as string | undefined;
    if (agentRole) {
      const check = canDeleteTask(agentRole as AgentRole);
      if (!check.allowed) return reply.code(403).send({ error: check.reason });
    }

    const { rowCount } = await getPool().query("DELETE FROM tasks WHERE id = $1", [request.params.id]);
    if (!rowCount) return reply.code(404).send({ error: "Task not found" });
    return { deleted: true };
  });

  // ─── Task Comments ───

  app.get<{ Params: { id: string } }>("/tasks/:id/comments", async (request) => {
    const { rows } = await getPool().query(
      "SELECT * FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC",
      [request.params.id],
    );
    return parseRows(commentSchema, rows);
  });

  app.post<{ Params: { id: string } }>("/tasks/:id/comments", async (request, reply) => {
    const body = z.object({
      author: z.string().min(1),
      body: z.string().min(1),
    }).parse(request.body);

    const { rows } = await getPool().query(
      "INSERT INTO task_comments (task_id, author, body) VALUES ($1, $2, $3) RETURNING *",
      [request.params.id, body.author, body.body],
    );
    return reply.code(201).send(parseRow(commentSchema, rows[0]));
  });
};
