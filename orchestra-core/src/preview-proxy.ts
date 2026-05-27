import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import fastifyReplyFrom from "@fastify/reply-from";
import { Transform, type TransformCallback } from "node:stream";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { previewEnvs } from "./db/schema";
import { userCanAccessProject } from "./project-access";
import { wake, touchLastRequest } from "./preview-manager";
import { log } from "./obs";

/**
 * Reverse-proxy for per-project preview contours. See
 * docs/PREVIEW_CONTOUR_DESIGN.md.
 *
 * Route shape:  /preview/<projectId>/<...>
 *
 * Uses @fastify/reply-from directly (NOT @fastify/http-proxy) because
 * the latter pins its undici dispatcher's `origin` to whatever
 * `upstream` was at registration time — so dynamic per-request hosts
 * (one DinD per project) silently route to the registration-time
 * placeholder and 500 on DNS. reply-from on its own respects the
 * full URL we pass to reply.from().
 *
 * Five rewrites paper over path-prefix proxying for apps that don't
 * know they're behind one:
 *
 *   1. URL: /preview/<id>/<x> → upstream /<x>
 *   2. <base href="/preview/<id>/"> injected into HTML <head>
 *   3. Set-Cookie: rewrite Path=/ to Path=/preview/<id> (isolates
 *      cookies across previews on the same host)
 *   4. Location: prefix root-relative redirects with /preview/<id>
 *   5. X-Forwarded-Prefix: /preview/<id> for app frameworks that
 *      honor it (Next.js basePath, Spring's server.forward-headers,
 *      Django's FORCE_SCRIPT_NAME via middleware)
 */

const ROUTE_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] as const;
const LAST_REQUEST_THROTTLE_MS = 30_000;
const lastTouchedAt = new Map<string, number>();

// Pre-resolve common ctx fields so the route handler can pass them
// down to the reply.from() options without re-querying.
interface PreviewCtx {
  projectId: string;
  pathPrefix: string;
  appPort: number;
  appProtocol: "http" | "https";
  innerPath: string; // path inside the preview (after stripping /preview/<id>)
}

function pickProtocol(port: number): "http" | "https" {
  return port === 443 || port === 8443 ? "https" : "http";
}

async function loadCtx(request: FastifyRequest, projectId: string): Promise<
  | { ok: true; ctx: PreviewCtx }
  | { ok: false; status: number; body: string | object; contentType?: string }
> {
  let userId: string | null = null;
  try {
    await request.jwtVerify();
    userId = (request.user as { id?: string } | undefined)?.id ?? null;
  } catch {
    /* unauthenticated */
  }
  if (!userId) {
    return {
      ok: false,
      status: 401,
      body: { error: "Требуется аутентификация. Войдите в дашборд." },
    };
  }

  if (!(await userCanAccessProject(userId, projectId))) {
    return { ok: false, status: 404, body: { error: "Проект не найден" } };
  }

  const rows = await getDb().select().from(previewEnvs).where(eq(previewEnvs.projectId, projectId));
  const row = rows[0];
  if (!row || !row.enabled) {
    return { ok: false, status: 404, body: { error: "Preview-контур не настроен для этого проекта" } };
  }
  if (row.state === "error") {
    return { ok: false, status: 502, contentType: "text/html; charset=utf-8", body: errorPage(row.errorMessage ?? "unknown error") };
  }
  if (row.state === "stopped") {
    return { ok: false, status: 404, contentType: "text/html; charset=utf-8", body: stoppedPage() };
  }
  if (row.state === "sleeping") {
    wake(projectId).catch((err) => log.warn({ err, projectId }, "preview-proxy: wake failed"));
    return { ok: false, status: 503, contentType: "text/html; charset=utf-8", body: wakingPage(projectId) };
  }
  if (row.state === "building") {
    return { ok: false, status: 503, contentType: "text/html; charset=utf-8", body: buildingPage(projectId) };
  }

  // state === 'running'
  const prefix = `/preview/${projectId}`;
  const innerPath = request.url.slice(prefix.length) || "/";
  return {
    ok: true,
    ctx: {
      projectId,
      pathPrefix: prefix,
      appPort: row.appPort,
      appProtocol: pickProtocol(row.appPort),
      innerPath,
    },
  };
}

// ─── HTML body transform: inject <base href="..."> into <head> ─────────────

export function baseInjector(prefix: string): Transform {
  const TAG = "<head";
  const baseTag = `<base href="${prefix}/">`;
  let pending = "";
  let done = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      if (done) return cb(null, chunk);
      pending += chunk.toString("utf-8");
      const idx = pending.toLowerCase().indexOf(TAG);
      if (idx === -1) {
        const keep = Math.min(TAG.length - 1, pending.length);
        const emit = pending.slice(0, pending.length - keep);
        pending = pending.slice(pending.length - keep);
        return cb(null, Buffer.from(emit, "utf-8"));
      }
      const close = pending.indexOf(">", idx);
      if (close === -1) return cb();
      const before = pending.slice(0, close + 1);
      const after = pending.slice(close + 1);
      done = true;
      pending = "";
      cb(null, Buffer.from(before + baseTag + after, "utf-8"));
    },
    flush(cb: TransformCallback) {
      if (pending) cb(null, Buffer.from(pending, "utf-8"));
      else cb();
    },
  });
}

// ─── Header rewriters ─────────────────────────────────────────────────────

export function rewriteSetCookie(setCookie: string[] | undefined, prefix: string): string[] | undefined {
  if (!setCookie) return setCookie;
  return setCookie.map((c) => c.replace(/(;\s*Path=)\/(?=\s*;|\s*$)/i, `$1${prefix}`));
}

export function rewriteLocation(location: string | undefined, prefix: string): string | undefined {
  if (!location) return location;
  if (location.startsWith("/") && !location.startsWith("//")) return prefix + location;
  return location;
}

// ─── Page templates ───────────────────────────────────────────────────────

function wakingPage(projectId: string): string {
  return interstitial({ title: "Preview is starting…", body: "Контейнер preview просыпается. Это занимает 5-15 секунд. Страница обновится автоматически.", refresh: 3, projectId });
}

function buildingPage(projectId: string): string {
  return interstitial({ title: "Preview is building…", body: "Идёт сборка docker-образа. Это может занять до минуты. Страница обновится автоматически.", refresh: 5, projectId });
}

function stoppedPage(): string {
  return interstitial({ title: "Preview is stopped", body: "Preview-контур не запущен. Запустите его в дашборде: Settings → Preview Environment → Deploy.", refresh: 0 });
}

function errorPage(message: string): string {
  return interstitial({ title: "Preview failed", body: `Preview-контур упал с ошибкой:\n\n${message}\n\nПроверьте логи в дашборде и попробуйте Redeploy.`, refresh: 0 });
}

interface InterstitialOpts {
  title: string;
  body: string;
  refresh: number;
  projectId?: string;
}

function interstitial(opts: InterstitialOpts): string {
  const refresh = opts.refresh > 0 ? `<meta http-equiv="refresh" content="${opts.refresh}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(opts.title)}</title>${refresh}
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:80px auto;color:#333;padding:0 16px}h1{font-size:22px;margin-bottom:12px}pre{background:#f4f4f4;padding:12px;border-radius:6px;overflow:auto;white-space:pre-wrap}</style>
</head><body><h1>${escapeHtml(opts.title)}</h1><pre>${escapeHtml(opts.body)}</pre></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// ─── Plugin ───────────────────────────────────────────────────────────────

export const previewProxyPlugin: FastifyPluginAsync = async (app) => {
  // Register reply-from with NO base — that's the key. Per-request we
  // pass reply.from() the full upstream URL, including host:port, and
  // reply-from's undici dispatcher uses opts.url.origin as the actual
  // destination (it falls back to baseUrl only when baseUrl is set).
  await app.register(fastifyReplyFrom, {
    undici: {
      connections: 100,
      pipelining: 1,
      // Preview apps commonly front themselves with caddy `tls internal`
      // or other self-signed setups; the per-project docker network is
      // the real trust boundary, so we don't verify upstream TLS.
      connect: { rejectUnauthorized: false },
    },
  });

  const url = "/preview/:projectId/*";
  app.route({
    method: ROUTE_METHODS as unknown as string[],
    url,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const projectId = (request.params as { projectId?: string }).projectId ?? "";
      const result = await loadCtx(request, projectId);
      if (!result.ok) {
        if (result.contentType) reply.type(result.contentType);
        return reply.code(result.status).send(result.body);
      }
      const { ctx } = result;

      // Throttled last-request bump so a chatty SPA doesn't UPDATE
      // hot in the DB.
      const now = Date.now();
      const last = lastTouchedAt.get(ctx.projectId) ?? 0;
      if (now - last > LAST_REQUEST_THROTTLE_MS) {
        lastTouchedAt.set(ctx.projectId, now);
        touchLastRequest(ctx.projectId).catch((err) =>
          log.warn({ err, projectId: ctx.projectId }, "preview-proxy: touchLastRequest failed"),
        );
      }

      const upstream = `${ctx.appProtocol}://preview-dind-${ctx.projectId}:${ctx.appPort}${ctx.innerPath}`;

      return reply.from(upstream, {
        rewriteRequestHeaders: (req, headers) => {
          headers["x-forwarded-prefix"] = ctx.pathPrefix;
          headers["x-forwarded-host"] = req.headers["host"] ?? "";
          return headers;
        },
        rewriteHeaders: (headers) => {
          const out = { ...headers };
          out["set-cookie"] = rewriteSetCookie(out["set-cookie"], ctx.pathPrefix);
          if (typeof out.location === "string") {
            const rewritten = rewriteLocation(out.location, ctx.pathPrefix);
            if (rewritten !== undefined) out.location = rewritten;
          }
          return out;
        },
        onResponse: (_request, replyObj, response) => {
          const ct = String(replyObj.getHeader("content-type") ?? "").toLowerCase();
          if (ct.startsWith("text/html")) {
            replyObj.removeHeader("content-length");
            void replyObj.send(response.stream.pipe(baseInjector(ctx.pathPrefix)));
          } else {
            void replyObj.send(response.stream);
          }
        },
      });
    },
  });
};
