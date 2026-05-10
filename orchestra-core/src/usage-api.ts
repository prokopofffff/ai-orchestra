import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { projects } from "./db/schema";
import { getDailyCostBreakdown, getCostsInRange, getDailyCostSeries } from "./cost-tracker";
import { resolveDailyCostCap } from "./limits";
import { currentUserId } from "./auth";
import { userCanAccessProject, visibleProjectIds } from "./project-access";

const querySchema = z.object({
  projectId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const usagePlugin: FastifyPluginAsync = async (app) => {
  /**
   * Project-scoped 24h spend with breakdown by role/model and the configured
   * cap. Used by the dashboard's Usage widget.
   */
  app.get<{ Querystring: { projectId: string } }>("/usage/today", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.query.projectId;
    if (!projectId) return reply.code(400).send({ error: "projectId required" });

    if (!(await userCanAccessProject(userId, projectId))) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const [row] = await getDb()
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "Project not found" });

    const breakdown = await getDailyCostBreakdown(projectId);
    const cap = resolveDailyCostCap(row.settings);
    return { ...breakdown, cap };
  });

  /**
   * Range query for charts and reporting. All filters optional; total returned
   * alongside the per-(project, role, model) breakdown — but always scoped to
   * the projects the caller can see, so a leak via an unfiltered query is
   * impossible.
   */
  app.get("/usage/costs", async (request, reply) => {
    const userId = currentUserId(request);
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const opts = parsed.data;

    if (opts.projectId && !(await userCanAccessProject(userId, opts.projectId))) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const visible = opts.projectId ? [opts.projectId] : await visibleProjectIds(userId);
    if (!visible.length) return { total: 0, rows: [] };
    return await getCostsInRange({ ...opts, projectIds: visible });
  });

  /**
   * Daily-bucketed series over the last N days (max 90), with role/model
   * breakdown per bucket. Empty days included so the chart x-axis stays
   * contiguous regardless of activity.
   */
  app.get<{ Querystring: { projectId?: string; days?: string } }>("/usage/costs/series", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.query.projectId;
    const days = Number(request.query.days ?? 7);
    if (!Number.isFinite(days) || days < 1) {
      return reply.code(400).send({ error: "days must be a positive integer" });
    }
    if (projectId && !/^[0-9a-f-]{36}$/i.test(projectId)) {
      return reply.code(400).send({ error: "projectId must be a UUID" });
    }
    if (projectId) {
      if (!(await userCanAccessProject(userId, projectId))) {
        return reply.code(404).send({ error: "Project not found" });
      }
      const series = await getDailyCostSeries({ projectId, days });
      return { days: series };
    }
    const visible = await visibleProjectIds(userId);
    if (!visible.length) return { days: [] };
    const series = await getDailyCostSeries({ projectIds: visible, days });
    return { days: series };
  });
};
