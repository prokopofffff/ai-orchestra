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
import { notify, escalate } from "./notification-hub";
import { background, logBackgroundError } from "./error-handler";
import { validateSignalSender } from "./agent-auth";
import { resolveMaxRevisions, resolveMaxSignalsPerTask, resolveMaxFails, resolveMaxQaDepth } from "./limits";
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

    // 1a. Q&A depth cap. Counts prior `question` signals on this task; the
    // (N+1)-th question is rejected so a chatty agent ↔ TL pair can't loop
    // through the spawn cycle indefinitely. Answers don't count themselves —
    // they just continue an existing round.
    if (signal.taskId && signal.action === "question") {
      const { rows: settingsRows } = await getPool().query(
        "SELECT settings FROM projects WHERE id = $1", [signal.projectId],
      );
      const qaCap = resolveMaxQaDepth(settingsRows[0]?.settings);
      const { rows: priorRows } = await getPool().query(
        "SELECT COUNT(*)::int AS c FROM signals WHERE task_id = $1 AND action = 'question'",
        [signal.taskId],
      );
      const prior = priorRows[0]?.c as number;
      if (prior >= qaCap) {
        // Single escalate — distinguish the first rejection from later ones
        // by looking for a prior reject audit on this same task.
        const { rows: priorRejects } = await getPool().query(
          `SELECT 1 FROM flow_audit
            WHERE task_id = $1 AND status = 'rejected' AND reason = 'qa_depth_exceeded'
            LIMIT 1`,
          [signal.taskId],
        );
        await logAudit(signal, "rejected", "qa_depth_exceeded");
        if (priorRejects.length === 0) {
          await escalate(
            signal.projectId, signal.taskId,
            `Q&A depth ${qaCap} reached on task — possible loop`,
            { event: "qa_depth_cap", count: prior, cap: qaCap },
          );
        }
        return reply.code(429).send({ error: `Q&A depth cap exceeded (${prior}/${qaCap})` });
      }
    }

    // 1b. Per-task signal cap. Catches loops that drown the system in valid
    // but redundant signals. Counter on tasks.signals_count is INC'd after
    // store; this branch reads the prior value and silently rejects past cap.
    if (signal.taskId) {
      const { rows: settingsRows } = await getPool().query(
        "SELECT settings FROM projects WHERE id = $1", [signal.projectId],
      );
      const sigCap = resolveMaxSignalsPerTask(settingsRows[0]?.settings);
      const { rows: countRows } = await getPool().query(
        "SELECT signals_count FROM tasks WHERE id = $1", [signal.taskId],
      );
      const current = (countRows[0]?.signals_count as number | undefined) ?? 0;
      if (current >= sigCap) {
        await logAudit(signal, "rejected", "signal_cap_exceeded");
        return reply.code(429).send({ error: `Signal cap exceeded for task (${current}/${sigCap})` });
      }
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

    // 5a. Increment signals_count. Boundary escalate (one shot) when newly
    // hitting the cap so the user knows; further sends will hit the silent
    // reject branch above.
    if (signal.taskId) {
      const { rows: settingsRows } = await getPool().query(
        "SELECT settings FROM projects WHERE id = $1", [signal.projectId],
      );
      const sigCap = resolveMaxSignalsPerTask(settingsRows[0]?.settings);
      const { rows: incRows } = await getPool().query(
        `UPDATE tasks SET signals_count = signals_count + 1, updated_at = now()
          WHERE id = $1 RETURNING signals_count`,
        [signal.taskId],
      );
      const newCount = (incRows[0]?.signals_count as number | undefined) ?? 0;
      if (newCount === sigCap) {
        await escalate(
          signal.projectId, signal.taskId,
          `Task exceeded ${sigCap} signals — possible loop`,
          { event: "signal_cap", count: newCount, cap: sigCap },
        );
      }
    }

    // 5c. Failed-loop counter — tests_failed sends task back to dev. Same
    // shape as revisions: INC, freeze + escalate at the cap.
    if (signal.taskId && signal.action === "tests_failed") {
      const { rows: settingsRows } = await getPool().query(
        "SELECT settings FROM projects WHERE id = $1", [signal.projectId],
      );
      const cap = resolveMaxFails(settingsRows[0]?.settings);
      const { rows: taskRows } = await getPool().query(
        `UPDATE tasks SET failed_count = failed_count + 1, updated_at = now()
          WHERE id = $1 RETURNING failed_count`,
        [signal.taskId],
      );
      const count = (taskRows[0]?.failed_count as number | undefined) ?? 0;
      if (count >= cap) {
        const reason = `Failed-loop cap reached (${count}/${cap}) — manual review needed`;
        await getPool().query(
          `UPDATE tasks SET frozen_reason = COALESCE(frozen_reason, $1), updated_at = now()
            WHERE id = $2`,
          [reason, signal.taskId],
        );
        await escalate(signal.projectId, signal.taskId, reason, {
          event: "failed_cap", count, cap,
        });
        return reply.code(202).send({ id: rows[0].id, status: "frozen", reason });
      }
    }

    // 5b. Revisions counter — pr_changes_requested means another loop with dev.
    // Counter resets on merge (pr-watcher). When the cap is hit we freeze the
    // task and escalate; the dispatcher's frozen_reason gate keeps further
    // signals from spawning anyone.
    if (signal.taskId && signal.action === "pr_changes_requested") {
      const { rows: settingsRows } = await getPool().query(
        "SELECT settings FROM projects WHERE id = $1", [signal.projectId],
      );
      const cap = resolveMaxRevisions(settingsRows[0]?.settings);
      const { rows: taskRows } = await getPool().query(
        `UPDATE tasks SET revisions_count = revisions_count + 1, updated_at = now()
          WHERE id = $1 RETURNING revisions_count`,
        [signal.taskId],
      );
      const count = (taskRows[0]?.revisions_count as number | undefined) ?? 0;
      if (count >= cap) {
        const reason = `Revisions cap reached (${count}/${cap}) — manual review needed`;
        await getPool().query(
          `UPDATE tasks SET frozen_reason = COALESCE(frozen_reason, $1), updated_at = now()
            WHERE id = $2`,
          [reason, signal.taskId],
        );
        await escalate(signal.projectId, signal.taskId, reason, {
          event: "revisions_cap", count, cap,
        });
        return reply.code(202).send({ id: rows[0].id, status: "frozen", reason });
      }
    }

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
