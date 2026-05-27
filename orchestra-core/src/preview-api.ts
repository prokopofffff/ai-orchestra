import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import Docker from "dockerode";
import { getDb } from "./db";
import { previewEnvs } from "./db/schema";
import { currentUserId } from "./auth";
import { userCanAccessProject, userCanEditProject } from "./project-access";
import { encryptJson, decryptJson } from "./secrets";
import { deploy, stop, wake, teardown, touchLastRequest } from "./preview-manager";
import { log } from "./obs";

/**
 * REST surface for per-project preview contour. See
 * docs/PREVIEW_CONTOUR_DESIGN.md.
 *
 * Read endpoints gate on userCanAccessProject; write/lifecycle endpoints
 * gate on userCanEditProject. Environment-variable VALUES are never
 * returned to the client — only the key list — so a viewer can't pull
 * decrypted secrets even if they have read access.
 *
 * Deploy/wake/stop block until the underlying preview-manager call
 * resolves (≤60s deploy, ≤30s wake). That's acceptable for the dashboard
 * which already shows pending UI; clients hitting it from scripts should
 * use a reasonable HTTP timeout.
 */

const ConfigBody = z.object({
  enabled: z.boolean().optional(),
  dockerfilePath: z.string().min(1).max(512).nullable().optional(),
  composeFilePath: z.string().min(1).max(512).nullable().optional(),
  branch: z.string().min(1).max(256).optional(),
  appPort: z.number().int().min(1).max(65535).optional(),
  envVars: z.record(z.string(), z.string()).optional(),
  idleTimeoutMinutes: z.number().int().min(1).max(10080).optional(),
  autoRedeployOnPush: z.boolean().optional(),
});

const DeployBody = z.object({ branch: z.string().min(1).max(256).optional() }).optional();

function envKeyList(blob: string | null): string[] {
  if (!blob) return [];
  try {
    return Object.keys(decryptJson<Record<string, string>>(blob)).sort();
  } catch {
    return [];
  }
}

export const previewPlugin: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>(
    "/projects/:id/preview",
    async (request, reply) => {
      const userId = currentUserId(request);
      const projectId = request.params.id;
      if (!(await userCanAccessProject(userId, projectId))) {
        return reply.code(404).send({ error: "Проект не найден" });
      }
      const rows = await getDb().select().from(previewEnvs).where(eq(previewEnvs.projectId, projectId));
      const row = rows[0];
      if (!row) {
        // Sane defaults for a project that's never been configured.
        return {
          enabled: false,
          dockerfilePath: null,
          composeFilePath: null,
          branch: "main",
          appPort: 8080,
          envVarKeys: [],
          idleTimeoutMinutes: 120,
          autoRedeployOnPush: true,
          state: "stopped",
          currentCommit: null,
          lastDeployedAt: null,
          lastRequestAt: null,
          errorMessage: null,
        };
      }
      return {
        enabled: row.enabled,
        dockerfilePath: row.dockerfilePath,
        composeFilePath: row.composeFilePath,
        branch: row.branch,
        appPort: row.appPort,
        envVarKeys: envKeyList(row.envVarsEncrypted),
        idleTimeoutMinutes: row.idleTimeoutMinutes,
        autoRedeployOnPush: row.autoRedeployOnPush,
        state: row.state,
        currentCommit: row.currentCommit,
        lastDeployedAt: row.lastDeployedAt,
        lastRequestAt: row.lastRequestAt,
        errorMessage: row.errorMessage,
      };
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    "/projects/:id/preview",
    async (request, reply) => {
      const userId = currentUserId(request);
      const projectId = request.params.id;
      if (!(await userCanEditProject(userId, projectId))) {
        return reply.code(403).send({ error: "Недостаточно прав" });
      }
      const body = ConfigBody.parse(request.body ?? {});

      const existing = await getDb()
        .select()
        .from(previewEnvs)
        .where(eq(previewEnvs.projectId, projectId));

      const envVarsEncrypted =
        body.envVars !== undefined ? encryptJson(body.envVars) : existing[0]?.envVarsEncrypted ?? null;

      if (existing.length === 0) {
        await getDb().insert(previewEnvs).values({
          projectId,
          enabled: body.enabled ?? false,
          dockerfilePath: body.dockerfilePath ?? null,
          composeFilePath: body.composeFilePath ?? null,
          branch: body.branch ?? "main",
          appPort: body.appPort ?? 8080,
          envVarsEncrypted,
          idleTimeoutMinutes: body.idleTimeoutMinutes ?? 120,
          autoRedeployOnPush: body.autoRedeployOnPush ?? true,
        });
      } else {
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if (body.enabled !== undefined) patch.enabled = body.enabled;
        if (body.dockerfilePath !== undefined) patch.dockerfilePath = body.dockerfilePath;
        if (body.composeFilePath !== undefined) patch.composeFilePath = body.composeFilePath;
        if (body.branch !== undefined) patch.branch = body.branch;
        if (body.appPort !== undefined) patch.appPort = body.appPort;
        if (body.envVars !== undefined) patch.envVarsEncrypted = envVarsEncrypted;
        if (body.idleTimeoutMinutes !== undefined) patch.idleTimeoutMinutes = body.idleTimeoutMinutes;
        if (body.autoRedeployOnPush !== undefined) patch.autoRedeployOnPush = body.autoRedeployOnPush;
        await getDb().update(previewEnvs).set(patch).where(eq(previewEnvs.projectId, projectId));
      }
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/projects/:id/preview/deploy",
    async (request, reply) => {
      const userId = currentUserId(request);
      const projectId = request.params.id;
      if (!(await userCanEditProject(userId, projectId))) {
        return reply.code(403).send({ error: "Недостаточно прав" });
      }
      const body = DeployBody.parse(request.body ?? {});
      try {
        await deploy(projectId, body?.branch);
        return { ok: true };
      } catch (err) {
        log.error({ err, projectId }, "preview-api: deploy failed");
        return reply.code(500).send({ error: (err as Error).message ?? "deploy failed" });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/projects/:id/preview/stop",
    async (request, reply) => {
      const userId = currentUserId(request);
      const projectId = request.params.id;
      if (!(await userCanEditProject(userId, projectId))) {
        return reply.code(403).send({ error: "Недостаточно прав" });
      }
      try {
        await stop(projectId);
        return { ok: true };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message ?? "stop failed" });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/projects/:id/preview/teardown",
    async (request, reply) => {
      const userId = currentUserId(request);
      const projectId = request.params.id;
      if (!(await userCanEditProject(userId, projectId))) {
        return reply.code(403).send({ error: "Недостаточно прав" });
      }
      try {
        await teardown(projectId);
        return { ok: true };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message ?? "teardown failed" });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/projects/:id/preview/wake",
    async (request, reply) => {
      // Wake is benign (gets the app to a runnable state) — any reader of
      // the project can trigger it. The reverse-proxy will call this on
      // first hit when the preview is sleeping.
      const userId = currentUserId(request);
      const projectId = request.params.id;
      if (!(await userCanAccessProject(userId, projectId))) {
        return reply.code(404).send({ error: "Проект не найден" });
      }
      try {
        await wake(projectId);
        await touchLastRequest(projectId);
        return { ok: true };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message ?? "wake failed" });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
    "/projects/:id/preview/logs",
    async (request, reply) => {
      const userId = currentUserId(request);
      const projectId = request.params.id;
      if (!(await userCanAccessProject(userId, projectId))) {
        return reply.code(404).send({ error: "Проект не найден" });
      }
      const tail = Math.min(Math.max(parseInt(request.query.tail ?? "200", 10) || 200, 1), 5000);
      try {
        const dind = new Docker({ host: `preview-dind-${projectId}`, port: 2375, protocol: "http" });
        const buf = await dind.getContainer("preview-app").logs({
          stdout: true,
          stderr: true,
          tail,
          timestamps: true,
          follow: false,
        });
        // dockerode returns a multiplexed Buffer on non-TTY containers;
        // strip the 8-byte frame headers so the client gets readable text.
        return { lines: demuxDockerLogs(buf as unknown as Buffer) };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404) return { lines: [] };
        return reply.code(500).send({ error: (err as Error).message ?? "logs failed" });
      }
    },
  );
};

/**
 * Strip the 8-byte frame headers Docker prepends to each chunk of
 * multiplexed stdout/stderr (stream_type, _, _, _, size×4). Returns
 * lines (LF-split) with stream-type-blind concat — adequate for the
 * dashboard "tail" widget. Empty trailing line is dropped.
 */
function demuxDockerLogs(buf: Buffer): string[] {
  const out: string[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    const chunk = buf.subarray(i + 8, i + 8 + size).toString("utf-8");
    out.push(chunk);
    i += 8 + size;
  }
  return out.join("").split("\n").filter((l) => l.length > 0);
}
