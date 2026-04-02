import { Router } from "express";
import { z } from "zod";
import { getPool } from "./db.js";
import { parseRows } from "./db-utils.js";
import {
  validateSignal,
  validateStateTransition,
  getTargetState,
  logAudit,
  type SignalPayload,
} from "./flow-guard.js";
import { checkUnblocked } from "./dependency-engine.js";
import { dispatchSignal } from "./dispatcher.js";
import { loadConfig } from "./config.js";
import { notify } from "./notification-hub.js";

export const signalRouter: Router = Router();

const signalBodySchema = z.object({
  from: z.string(),
  to: z.string(),
  action: z.string(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  message: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
});

const auditSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  fromRole: z.string(),
  toRole: z.string(),
  action: z.string(),
  taskId: z.string().uuid().nullable(),
  status: z.string(),
  reason: z.string().nullable(),
  payload: z.record(z.unknown()),
  createdAt: z.coerce.date(),
});

// ─── Send Signal ───

signalRouter.post("/signal", async (req, res, next) => {
  try {
    const body = signalBodySchema.parse(req.body);
    const signal: SignalPayload = body;

    // 1. Validate route + action
    const routeCheck = validateSignal(signal);
    if (!routeCheck.allowed) {
      await logAudit(signal, "rejected", routeCheck.reason);
      return res.status(403).json({ error: routeCheck.reason });
    }

    // 2. If task-related, validate state transition
    if (signal.taskId) {
      const { rows } = await getPool().query("SELECT state FROM tasks WHERE id = $1", [signal.taskId]);
      if (rows.length) {
        const stateCheck = validateStateTransition(rows[0].state, signal.action);
        if (!stateCheck.allowed) {
          await logAudit(signal, "rejected", stateCheck.reason);
          return res.status(403).json({ error: stateCheck.reason });
        }

        // 3. Apply state transition
        const targetState = getTargetState(signal.action);
        if (targetState) {
          await getPool().query(
            "UPDATE tasks SET state = $1, updated_at = now() WHERE id = $2",
            [targetState, signal.taskId],
          );
        }
      }
    }

    // 4. Store signal
    const { rows } = await getPool().query(
      `INSERT INTO signals (project_id, task_id, from_role, to_role, action, payload)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [signal.projectId, signal.taskId ?? null, signal.from, signal.to, signal.action, JSON.stringify(signal.payload ?? {})],
    );

    // 5. Audit log
    await logAudit(signal, "allowed");

    // 6. Check if state change unblocks other tasks
    if (signal.taskId) {
      const targetState = getTargetState(signal.action);
      if (targetState === "merged" || targetState === "closed") {
        // Not in actionToTransition yet, but handle manual state updates
      }
    }

    // 7. Notify user for user-facing signals
    if (signal.to === "user" || ["pr_approved", "task_done", "escalate"].includes(signal.action)) {
      const payload = signal.payload as Record<string, unknown> | undefined;
      const message = (payload?.message as string) ?? `${signal.from}: ${signal.action}`;
      notify({
        projectId: signal.projectId,
        text: message,
        priority: signal.action === "escalate" ? "high" : "normal",
        fromRole: signal.from === "tech-lead" ? "tech-lead" : "system",
      }).catch(console.error);
    }

    // 8. Dispatch agent
    const config = loadConfig();
    dispatchSignal(signal, config).catch((err) =>
      console.error("Dispatch error:", err instanceof Error ? err.message : err),
    );

    res.status(201).json({ id: rows[0].id, status: "accepted" });
  } catch (e) { next(e); }
});

// ─── Audit Log ───

signalRouter.get("/flow/audit", async (req, res, next) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    let query = "SELECT * FROM flow_audit";
    const vals: unknown[] = [];

    if (projectId) {
      query += " WHERE project_id = $1";
      vals.push(projectId);
    }

    query += " ORDER BY created_at DESC LIMIT $" + (vals.length + 1);
    vals.push(limit);

    const { rows } = await getPool().query(query, vals);
    res.json(parseRows(auditSchema, rows));
  } catch (e) { next(e); }
});

signalRouter.get("/flow/violations", async (req, res, next) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    let query = "SELECT * FROM flow_audit WHERE status = 'rejected'";
    const vals: unknown[] = [];

    if (projectId) {
      query += " AND project_id = $1";
      vals.push(projectId);
    }

    query += " ORDER BY created_at DESC LIMIT $" + (vals.length + 1);
    vals.push(limit);

    const { rows } = await getPool().query(query, vals);
    res.json(parseRows(auditSchema, rows));
  } catch (e) { next(e); }
});

// ─── Pending Signals ───

signalRouter.get("/signals", async (req, res, next) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    const toRole = req.query.toRole as string | undefined;
    const unreadOnly = req.query.unread === "true";

    const wheres: string[] = [];
    const vals: unknown[] = [];
    let i = 1;

    if (projectId) { wheres.push(`project_id = $${i++}`); vals.push(projectId); }
    if (toRole) { wheres.push(`to_role = $${i++}`); vals.push(toRole); }
    if (unreadOnly) { wheres.push(`read = false`); }

    const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
    const { rows } = await getPool().query(
      `SELECT * FROM signals ${where} ORDER BY created_at DESC LIMIT 100`,
      vals,
    );
    res.json(rows);
  } catch (e) { next(e); }
});
