import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getPool } from "./db";
import { parseRows } from "./db-utils";
import {
  validateSignal,
  validateStateTransition,
  getTargetState,
  logAudit,
  type SignalPayload,
} from "./flow-guard";
import { checkUnblocked } from "./dependency-engine";
import { dispatchSignal } from "./dispatcher";
import { loadConfig } from "./config";
import { notify } from "./notification-hub";
import { background, logBackgroundError } from "./error-handler";
import { validateSignalSender } from "./agent-auth";
import { AuditEntrySchema } from "@ai-orchestra/shared";

const signalBodySchema = z.object({
  from: z.string(),
  to: z.string(),
  action: z.string(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  message: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
});

const auditSchema = AuditEntrySchema;

export const signalPlugin: FastifyPluginAsync = async (app) => {
  // ─── Send Signal ───

  app.post("/signal", async (request, reply) => {
    const body = signalBodySchema.parse(request.body);
    const signal: SignalPayload = body;

    // 0. Validate sender identity (prevent role impersonation)
    const agentRole = request.headers["x-agent-role"] as string | undefined;
    if (agentRole) {
      const senderCheck = validateSignalSender(signal.from, agentRole);
      if (!senderCheck.allowed) {
        await logAudit(signal, "rejected", senderCheck.reason);
        return reply.code(403).send({ error: senderCheck.reason });
      }
    }

    // 1. Validate route + action
    const routeCheck = validateSignal(signal);
    if (!routeCheck.allowed) {
      await logAudit(signal, "rejected", routeCheck.reason);
      return reply.code(403).send({ error: routeCheck.reason });
    }

    // 2. If task-related, validate state transition
    if (signal.taskId) {
      const { rows } = await getPool().query("SELECT state FROM tasks WHERE id = $1", [signal.taskId]);
      if (rows.length) {
        const currentState = rows[0].state as string;
        let stateCheck = validateStateTransition(currentState, signal.action);

        // Auto-advance through intermediate states if needed
        // e.g. new → described is required before assign_dev, so do it automatically
        if (!stateCheck.allowed && currentState === "new") {
          const targetState = getTargetState(signal.action);
          if (targetState && ["designing", "in_development"].includes(targetState)) {
            await getPool().query(
              "UPDATE tasks SET state = 'described', updated_at = now() WHERE id = $1",
              [signal.taskId],
            );
            stateCheck = validateStateTransition("described", signal.action);
          }
        }

        if (!stateCheck.allowed) {
          await logAudit(signal, "rejected", stateCheck.reason);
          return reply.code(403).send({ error: stateCheck.reason });
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
      const doneStates = ["tested", "approved", "merged", "closed", "design_ready"];
      if (targetState && doneStates.includes(targetState)) {
        background(checkUnblocked(signal.taskId, signal.projectId), "checkUnblocked", signal.projectId);
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
      }).catch((err) => logBackgroundError("signal:notify", err, signal.projectId));
    }

    // 8. Dispatch agent
    const config = loadConfig();
    background(dispatchSignal(signal, config), "signal:dispatch", signal.projectId);

    return reply.code(201).send({ id: rows[0].id, status: "accepted" });
  });

  // ─── Audit Log ───

  app.get("/flow/audit", async (request) => {
    const query_ = request.query as Record<string, string>;
    const projectId = query_.projectId;
    const limit = Math.min(Number(query_.limit) || 50, 200);

    let query = "SELECT * FROM flow_audit";
    const vals: unknown[] = [];

    if (projectId) {
      query += " WHERE project_id = $1";
      vals.push(projectId);
    }

    query += " ORDER BY created_at DESC LIMIT $" + (vals.length + 1);
    vals.push(limit);

    const { rows } = await getPool().query(query, vals);
    return parseRows(auditSchema, rows);
  });

  app.get("/flow/violations", async (request) => {
    const query_ = request.query as Record<string, string>;
    const projectId = query_.projectId;
    const limit = Math.min(Number(query_.limit) || 50, 200);

    let query = "SELECT * FROM flow_audit WHERE status = 'rejected'";
    const vals: unknown[] = [];

    if (projectId) {
      query += " AND project_id = $1";
      vals.push(projectId);
    }

    query += " ORDER BY created_at DESC LIMIT $" + (vals.length + 1);
    vals.push(limit);

    const { rows } = await getPool().query(query, vals);
    return parseRows(auditSchema, rows);
  });

  // ─── Pending Signals ───

  app.get("/signals", async (request) => {
    const query_ = request.query as Record<string, string>;
    const projectId = query_.projectId;
    const toRole = query_.toRole;
    const unreadOnly = query_.unread === "true";

    const wheres: string[] = [];
    const vals: unknown[] = [];
    let i = 1;

    if (projectId) { wheres.push(`project_id = $${i++}`); vals.push(projectId); }
    if (toRole) { wheres.push(`to_role = $${i++}`); vals.push(toRole); } // eslint-disable-line no-useless-assignment
    if (unreadOnly) { wheres.push(`read = false`); }

    const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
    const { rows } = await getPool().query(
      `SELECT * FROM signals ${where} ORDER BY created_at DESC LIMIT 100`,
      vals,
    );
    return rows;
  });
};
