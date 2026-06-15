import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, getPool } from "./db";
import { flowAudit, signals as signalsTable, projects, taskComments, projectNotes } from "./db/schema";
import { parseRows } from "./db-utils";
import {
  validateSignal,
  validateStateTransition,
  getTargetState,
  logAudit,
  type SignalPayload,
} from "./flow-guard";
import { allActions, allSenderRoles, allRecipientRoles } from "@ai-orchestra/shared";
import { checkUnblocked, DONE_STATES } from "./dependency-engine";
import { dispatchSignal } from "./dispatcher";
import { loadConfig } from "./config";
import { notify, escalate, notifyPrReady } from "./notification-hub";
import { background, logBackgroundError } from "./error-handler";
import { tryAutoMerge } from "./auto-merger";
import { validateSignalSender } from "./agent-auth";
import { currentUserId, authorizeProject } from "./auth";
import { userCanAccessProject, visibleProjectIds } from "./project-access";
import { resolveMaxRevisions, resolveMaxSignalsPerTask, resolveMaxFails, resolveMaxQaDepth } from "./limits";
import { AuditEntrySchema } from "@ai-orchestra/shared";

// from/to/action are constrained at the schema boundary so a typo (`comlete_task`,
// `tech_lead` with underscore, …) gets a 400 listing the valid options instead
// of being silently stored, audit-logged, and dropped by the runtime guard.
// The downstream `validateSignal` still enforces the role × action matrix —
// this layer is the cheap fail-fast filter.
const signalFromSchema = z.enum(allSenderRoles as [string, ...string[]]);
const signalToSchema = z.enum(allRecipientRoles as [string, ...string[]]);
const signalActionSchema = z.enum(allActions as [string, ...string[]]);

const signalBodySchema = z.object({
  from: signalFromSchema,
  to: signalToSchema,
  action: signalActionSchema,
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

    // 0a. Project membership: only members can post signals into a project's
    // workflow. Agent runs present a signed agent token (kind:"agent") that
    // binds their role + the single project they may act on — derived from
    // the JWT, never a client header, so a logged-in human can't spoof an
    // agent to inject signals into a project they don't belong to.
    const authz = await authorizeProject(request, signal.projectId, "edit");
    if (!authz.ok) {
      await logAudit(
        signal, "rejected",
        authz.reason === "scope-mismatch" ? "agent token project scope mismatch" : "no project access",
      );
      return reply.code(403).send({ error: "Недостаточно прав доступа к проекту" });
    }
    const agentRole = authz.agentRole;

    // 0b. Validate sender identity (prevent role impersonation)
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

    // 6. Check if state change unblocks other tasks. DONE_STATES is the
    // single source of truth — approved/tested don't count, only merged
    // (and closed / design_ready). See dependency-engine.ts for the why.
    if (signal.taskId) {
      const targetState = getTargetState(signal.action);
      if (targetState && (DONE_STATES as readonly string[]).includes(targetState)) {
        background(checkUnblocked(signal.taskId, signal.projectId), "checkUnblocked", signal.projectId);
        // If this is the project's intro task, promote TL's last comment
        // into project_notes so it sticks around as the project's
        // codebase summary.
        background(maybePromoteIntroSummary(signal.projectId, signal.taskId), "intro:promote", signal.projectId);
      }
    }

    // 7. Notify user for user-facing signals
    if (signal.to === "user" || ["pr_approved", "task_done", "escalate"].includes(signal.action)) {
      const payload = signal.payload as Record<string, unknown> | undefined;
      const message = (payload?.message as string) ?? `${signal.from}: ${signal.action}`;

      // pr_approved special case: pull the canonical pr_url from tasks and
      // route through notifyPrReady so the user always gets the link in the
      // Telegram message, even if the TL forgot to include it in payload.
      // Without this, the URL only lives in the dashboard's task view —
      // anyone reading the notification has to switch context to find it.
      if (signal.action === "pr_approved" && signal.taskId) {
        background(
          (async () => {
            const { rows } = await getPool().query<{ pr_url: string | null; title: string | null }>(
              "SELECT pr_url, title FROM tasks WHERE id = $1 LIMIT 1",
              [signal.taskId],
            );
            const prUrl = rows[0]?.pr_url ?? null;
            const taskTitle = rows[0]?.title ?? "PR";
            if (prUrl) {
              await notifyPrReady(signal.projectId, taskTitle, prUrl);
            } else {
              // No URL recorded (e.g. PR was created out-of-band) — fall back
              // to whatever the TL put in payload so we don't drop the signal.
              await notify({
                projectId: signal.projectId,
                text: message,
                priority: "normal",
                fromRole: "tech-lead",
              });
            }
          })(),
          "signal:notify-pr-ready",
          signal.projectId,
        );
      } else {
        notify({
          projectId: signal.projectId,
          text: message,
          priority: signal.action === "escalate" ? "high" : "normal",
          fromRole: signal.from === "tech-lead" ? "tech-lead" : "system",
        }).catch((err) => logBackgroundError("signal:notify", err, signal.projectId));
      }
    }

    // 7b. Auto-merge (opt-in per project). The actual merge happens in a
    // background promise so the signal endpoint stays snappy and a slow
    // provider doesn't 504 the request. tryAutoMerge no-ops when settings
    // don't have it enabled, when the task lacks a pr_url, or when the
    // project has no remote (local-path-only).
    if (signal.action === "pr_approved" && signal.from === "tech-lead" && signal.taskId) {
      background(tryAutoMerge(signal.projectId, signal.taskId), "signal:auto-merge", signal.projectId);
    }

    // 8. Dispatch agent
    const config = loadConfig();
    background(dispatchSignal(signal, config), "signal:dispatch", signal.projectId);

    return reply.code(201).send({ id: rows[0].id, status: "accepted" });
  });

  // ─── Audit Log ───

  app.get("/flow/audit", async (request, reply) => {
    return await listAudit(request, reply, /* rejectedOnly */ false);
  });

  app.get("/flow/violations", async (request, reply) => {
    return await listAudit(request, reply, /* rejectedOnly */ true);
  });

  // ─── Pending Signals ───

  app.get("/signals", async (request, reply) => {
    const userId = currentUserId(request);
    const q = request.query as Record<string, string>;
    const toRole = q.toRole;
    const unreadOnly = q.unread === "true";

    if (q.projectId && !(await userCanAccessProject(userId, q.projectId))) {
      return reply.code(404).send({ error: "Проект не найден" });
    }
    const visible = q.projectId ? [q.projectId] : await visibleProjectIds(userId);
    if (!visible.length) return [];

    const conds = [inArray(signalsTable.projectId, visible)];
    if (toRole) conds.push(eq(signalsTable.toRole, toRole));
    if (unreadOnly) conds.push(eq(signalsTable.read, false));

    return await getDb()
      .select()
      .from(signalsTable)
      .where(and(...conds))
      .orderBy(desc(signalsTable.createdAt))
      .limit(100);
  });
};

/**
 * When the project's intro task transitions to a done state, copy
 * Tech Lead's most recent comment into project_notes(kind='intro_summary').
 * No-op if this isn't the intro task or if TL didn't leave a comment.
 */
async function maybePromoteIntroSummary(projectId: string, taskId: string): Promise<void> {
  const db = getDb();

  const [proj] = await db
    .select({ introTaskId: projects.introTaskId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!proj || proj.introTaskId !== taskId) return;

  const [comment] = await db
    .select({ body: taskComments.body, createdAt: taskComments.createdAt })
    .from(taskComments)
    .where(and(eq(taskComments.taskId, taskId), eq(taskComments.author, "tech-lead")))
    .orderBy(desc(taskComments.createdAt))
    .limit(1);
  if (!comment) return;

  // Idempotent — re-promotion just refreshes the row. Useful if TL hits
  // the same terminal state twice (e.g. unfreeze + complete again).
  const [existing] = await db
    .select({ id: projectNotes.id })
    .from(projectNotes)
    .where(and(eq(projectNotes.projectId, projectId), eq(projectNotes.kind, "intro_summary")))
    .limit(1);
  if (existing) {
    await db
      .update(projectNotes)
      .set({ body: comment.body, updatedAt: comment.createdAt })
      .where(eq(projectNotes.id, existing.id));
  } else {
    await db.insert(projectNotes).values({
      projectId,
      kind: "intro_summary",
      body: comment.body,
      author: "tech-lead",
    });
  }
}

async function listAudit(
  request: FastifyRequest,
  reply: FastifyReply,
  rejectedOnly: boolean,
) {
  const userId = currentUserId(request);
  const q = request.query as Record<string, string>;
  const limit = Math.min(Number(q.limit) || 50, 200);

  if (q.projectId && !(await userCanAccessProject(userId, q.projectId))) {
    return reply.code(404).send({ error: "Проект не найден" });
  }
  const visible = q.projectId ? [q.projectId] : await visibleProjectIds(userId);
  if (!visible.length) return [];

  const conds = [inArray(flowAudit.projectId, visible)];
  if (rejectedOnly) conds.push(eq(flowAudit.status, "rejected"));

  const rows = await getDb()
    .select()
    .from(flowAudit)
    .where(and(...conds))
    .orderBy(desc(flowAudit.createdAt))
    .limit(limit);
  return parseRows(auditSchema, rows);
}
