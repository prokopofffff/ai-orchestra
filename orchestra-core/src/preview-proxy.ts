import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import fastifyHttpProxy from "@fastify/http-proxy";
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
 * Route shape (single):  /preview/<projectId>/<...>
 *
 * The same URL shape is used regardless of whether orchestra-core is
 * reached via the main host (example.com) or a dedicated preview
 * subdomain (preview.example.com) — the dashboard advertises whichever
 * hostname `PREVIEW_HOST` configures, browser cookies scope per-host
 * automatically, so a separate hostname is sufficient to keep preview
 * cookies from colliding with dashboard cookies. No wildcard DNS or
 * cert needed in either configuration.
 *
 * Five rewrites are applied to make path-prefix proxying as
 * transparent as possible to apps that don't know they're behind one:
 *
 *   1. URL: `/preview/<id>/<x>` → upstream `/<x>`
 *   2. <base href="/preview/<id>/"> injected into HTML <head>
 *   3. Set-Cookie: rewrite `Path=/` to `Path=/preview/<id>` (isolates
 *      cookies across previews on the same host)
 *   4. Location: prefix root-relative redirects with /preview/<id>
 *   5. X-Forwarded-Prefix: /preview/<id> for app frameworks that
 *      honor it (Next.js basePath, Spring's server.forward-headers,
 *      Django's FORCE_SCRIPT_NAME via middleware)
 *
 * Apps that hard-code absolute URLs in their compiled JS bundle
 * (e.g. `fetch("/api/x")` after minification) must additionally be
 * built with their framework's basePath/base config pointing at
 * `/preview/<projectId>`. The reverse proxy can't rewrite bytes
 * inside compiled JS.
 */

const ROUTE_PREFIX = "/preview/:projectId";

// Pre-handler attaches the project to request so the upstream resolver
// + onResponse hooks don't need to re-query.
declare module "fastify" {
  interface FastifyRequest {
    previewCtx?: {
      projectId: string;
      pathPrefix: string;
      appPort: number;
      sleeping: boolean;
    };
  }
}

const LAST_REQUEST_THROTTLE_MS = 30_000;
const lastTouchedAt = new Map<string, number>();

async function preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const projectId = (request.params as { projectId?: string }).projectId;
  if (!projectId) {
    void reply.code(404).send({ error: "Не указан проект" });
    return;
  }

  // Authn: dashboard JWT cookie. Fall back to 401 → dashboard redirect.
  let userId: string | null = null;
  try {
    await request.jwtVerify();
    userId = (request.user as { id?: string } | undefined)?.id ?? null;
  } catch {
    // unauthenticated
  }
  if (!userId) {
    void reply.code(401).header("WWW-Authenticate", "Bearer").send({
      error: "Требуется аутентификация. Войдите в дашборд и обновите страницу.",
    });
    return;
  }

  if (!(await userCanAccessProject(userId, projectId))) {
    void reply.code(404).send({ error: "Проект не найден" });
    return;
  }

  const rows = await getDb().select().from(previewEnvs).where(eq(previewEnvs.projectId, projectId));
  const row = rows[0];
  if (!row || !row.enabled) {
    void reply.code(404).send({ error: "Preview-контур не настроен для этого проекта" });
    return;
  }
  if (row.state === "error") {
    void reply.code(502).type("text/html; charset=utf-8").send(errorPage(row.errorMessage ?? "unknown error"));
    return;
  }
  if (row.state === "stopped") {
    void reply.code(404).type("text/html; charset=utf-8").send(stoppedPage());
    return;
  }
  if (row.state === "sleeping") {
    // Best-effort wake — don't block the request thread on it; return
    // an interstitial that auto-refreshes.
    wake(projectId).catch((err) => log.warn({ err, projectId }, "preview-proxy: wake failed"));
    void reply.code(503).type("text/html; charset=utf-8").send(wakingPage(projectId));
    return;
  }
  if (row.state === "building") {
    void reply.code(503).type("text/html; charset=utf-8").send(buildingPage(projectId));
    return;
  }

  // state === 'running' — let the proxy through. Stash context for
  // upstream resolver + response hooks.
  request.previewCtx = {
    projectId,
    pathPrefix: `/preview/${projectId}`,
    appPort: row.appPort,
    sleeping: false,
  };

  // Throttle last-request bumps so a chatty SPA doesn't UPDATE a row
  // 200x/sec. 30s cadence is enough for idle-sweep correctness.
  const now = Date.now();
  const last = lastTouchedAt.get(projectId) ?? 0;
  if (now - last > LAST_REQUEST_THROTTLE_MS) {
    lastTouchedAt.set(projectId, now);
    touchLastRequest(projectId).catch((err) =>
      log.warn({ err, projectId }, "preview-proxy: touchLastRequest failed"),
    );
  }
}

// ─── HTML body transform: inject <base href="..."> into <head> ─────────────

export function baseInjector(prefix: string): Transform {
  // We only need to touch the first occurrence of <head> (or <head ...>).
  // Stream chunk-aware: keep a small tail across chunks to catch tag
  // boundaries that straddle. Once injected, switch to identity-passthrough.
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
        // Flush all but the last (TAG.length-1) chars to allow split tags
        const keep = Math.min(TAG.length - 1, pending.length);
        const emit = pending.slice(0, pending.length - keep);
        pending = pending.slice(pending.length - keep);
        return cb(null, Buffer.from(emit, "utf-8"));
      }
      // Found <head — find its closing '>'
      const close = pending.indexOf(">", idx);
      if (close === -1) {
        // Wait for more data
        return cb();
      }
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

// ─── Header rewriters: Set-Cookie Path, Location prefix ───────────────────

export function rewriteSetCookie(setCookie: string[] | undefined, prefix: string): string[] | undefined {
  if (!setCookie) return setCookie;
  // Replace explicit Path=/ (and only that — non-root paths should stay
  // verbatim since the app probably knows what it's doing) with the
  // preview-scoped path. Browsers default missing Path to the request
  // URL's directory; if the app omits Path entirely, the cookie ends up
  // scoped to /preview/<id>/<...> anyway, which is fine.
  return setCookie.map((c) => c.replace(/(;\s*Path=)\/(?=\s*;|\s*$)/i, `$1${prefix}`));
}

export function rewriteLocation(location: string | undefined, prefix: string): string | undefined {
  if (!location) return location;
  // Only rewrite root-relative absolute paths. Full URLs and
  // relative-to-current paths pass through unchanged.
  if (location.startsWith("/") && !location.startsWith("//")) {
    return prefix + location;
  }
  return location;
}

// ─── Page templates ───────────────────────────────────────────────────────

function wakingPage(projectId: string): string {
  return interstitial({
    title: "Preview is starting…",
    body: "Контейнер preview просыпается. Это занимает 5-15 секунд. Страница обновится автоматически.",
    refresh: 3,
    projectId,
  });
}

function buildingPage(projectId: string): string {
  return interstitial({
    title: "Preview is building…",
    body: "Идёт сборка docker-образа. Это может занять до минуты. Страница обновится автоматически.",
    refresh: 5,
    projectId,
  });
}

function stoppedPage(): string {
  return interstitial({
    title: "Preview is stopped",
    body: "Preview-контур не запущен. Запустите его в дашборде: Settings → Preview Environment → Deploy.",
    refresh: 0,
  });
}

function errorPage(message: string): string {
  return interstitial({
    title: "Preview failed",
    body: `Preview-контур упал с ошибкой:\n\n${escapeHtml(message)}\n\nПроверьте логи в дашборде и попробуйте Redeploy.`,
    refresh: 0,
  });
}

interface InterstitialOpts {
  title: string;
  body: string;
  refresh: number; // 0 = no auto-refresh
  projectId?: string;
}

function interstitial(opts: InterstitialOpts): string {
  const refresh = opts.refresh > 0 ? `<meta http-equiv="refresh" content="${opts.refresh}">` : "";
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>${escapeHtml(opts.title)}</title>
${refresh}
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 80px auto; color: #333; padding: 0 16px; }
  h1 { font-size: 22px; margin-bottom: 12px; }
  pre { background: #f4f4f4; padding: 12px; border-radius: 6px; overflow: auto; white-space: pre-wrap; }
</style>
</head><body>
<h1>${escapeHtml(opts.title)}</h1>
<pre>${escapeHtml(opts.body)}</pre>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// ─── Plugin ───────────────────────────────────────────────────────────────

export const previewProxyPlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifyHttpProxy, {
    // Dummy default — actual upstream picked per-request via getUpstream.
    upstream: "http://preview-dind-placeholder:8080",
    prefix: ROUTE_PREFIX,
    rewritePrefix: "",
    preHandler,
    httpMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
    websocket: false, // v1.7 skips ws; v2 can enable once we trust the wiring
    replyOptions: {
      getUpstream: (request) => {
        const ctx = (request as FastifyRequest).previewCtx;
        if (!ctx) return "http://preview-dind-placeholder:8080";
        return `http://preview-dind-${ctx.projectId}:${ctx.appPort}`;
      },
      rewriteHeaders: (headers, request) => {
        const ctx = (request as FastifyRequest | undefined)?.previewCtx;
        if (!ctx) return headers;
        const out = { ...headers };
        out["set-cookie"] = rewriteSetCookie(out["set-cookie"], ctx.pathPrefix);
        if (typeof out.location === "string") {
          const rewritten = rewriteLocation(out.location, ctx.pathPrefix);
          if (rewritten !== undefined) out.location = rewritten;
        }
        return out;
      },
      rewriteRequestHeaders: (request, headers) => {
        const ctx = (request as FastifyRequest).previewCtx;
        if (ctx) {
          headers["x-forwarded-prefix"] = ctx.pathPrefix;
          // Many apps inspect Host to build absolute URLs; pass the original
          // host so they don't end up pointing at preview-dind-<id>.
          headers["x-forwarded-host"] = request.headers["host"] ?? "";
        }
        return headers;
      },
      onResponse: (request, reply, response) => {
        const ctx = (request as FastifyRequest).previewCtx;
        const ct = String(reply.getHeader("content-type") ?? "").toLowerCase();
        if (ctx && ct.startsWith("text/html")) {
          // Strip content-length — we're mutating the body length.
          reply.removeHeader("content-length");
          const transformer = baseInjector(ctx.pathPrefix);
          void reply.send(response.stream.pipe(transformer));
        } else {
          void reply.send(response.stream);
        }
      },
    },
  });
};
