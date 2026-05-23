import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { projectContextCards } from "./db/schema";
import { currentUserId } from "./auth";
import { userCanAccessProject, userCanEditProject } from "./project-access";
import {
  generateCard,
  generateAllCards,
  KNOWN_CARD_KINDS,
  type CardKind,
} from "./context-card-generator";
import { log } from "./obs";

/**
 * REST surface for project context cards (Phase 3). Read endpoint is
 * scoped to any reader of the project; regenerate requires edit
 * permission (it costs money).
 */

const CardKindSchema = z.enum(["architecture", "decisions", "style", "recent_activity"]);

export const contextCardsPlugin: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>(
    "/projects/:id/context-cards",
    async (request, reply) => {
      const userId = currentUserId(request);
      const projectId = request.params.id;
      if (!(await userCanAccessProject(userId, projectId))) {
        return reply.code(404).send({ error: "Проект не найден" });
      }
      const cards = await getDb()
        .select()
        .from(projectContextCards)
        .where(eq(projectContextCards.projectId, projectId));
      return cards
        .sort((a, b) => a.kind.localeCompare(b.kind))
        .map((c) => ({
          kind: c.kind,
          content: c.content,
          tokenCount: c.tokenCount,
          sourceSha: c.sourceSha,
          generatorModel: c.generatorModel,
          costUsd: Number(c.costUsd),
          generatedAt: c.generatedAt,
        }));
    },
  );

  app.post<{
    Params: { id: string };
    Body: { kind?: CardKind; force?: boolean };
  }>("/projects/:id/context-cards/regenerate", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.params.id;
    if (!(await userCanEditProject(userId, projectId))) {
      return reply.code(403).send({ error: "Недостаточно прав для регенерации карточек" });
    }
    const body = z.object({
      kind: CardKindSchema.optional(),
      force: z.boolean().optional(),
    }).parse(request.body ?? {});

    try {
      const results = body.kind
        ? [await generateCard(projectId, body.kind, { force: body.force })]
        : await generateAllCards(projectId, { force: body.force });

      // Result shape mirrors the generator — surface every kind so the UI
      // can show "generated: 1, skipped: 3 (up-to-date)" instead of an
      // opaque success boolean.
      return { results };
    } catch (err) {
      log.error({ err, projectId, kind: body.kind }, "context card regeneration failed");
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Helper for the dashboard onboarding: which kinds are known. Keeps the
  // UI in sync without hard-coding the enum on both sides.
  app.get("/context-cards/kinds", async () => {
    return { kinds: KNOWN_CARD_KINDS };
  });
};
