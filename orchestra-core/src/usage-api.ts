import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getDailyCostBreakdown, getCostsInRange } from "./cost-tracker";
import { resolveDailyCostCap } from "./limits";
import { getPool } from "./db";

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
    const projectId = request.query.projectId;
    if (!projectId) return reply.code(400).send({ error: "projectId required" });

    const { rows } = await getPool().query(
      "SELECT settings FROM projects WHERE id = $1", [projectId],
    );
    if (!rows.length) return reply.code(404).send({ error: "Project not found" });

    const breakdown = await getDailyCostBreakdown(projectId);
    const cap = resolveDailyCostCap(rows[0].settings);
    return { ...breakdown, cap };
  });

  /**
   * Range query for charts and reporting. All filters optional; total returned
   * alongside the per-(project, role, model) breakdown.
   */
  app.get("/usage/costs", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    return await getCostsInRange(parsed.data);
  });
};
