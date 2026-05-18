# syntax=docker/dockerfile:1.7
#
# Multi-stage build that produces a single image containing every runtime
# piece of AI Orchestra:
#
#   - shared/             (built TypeScript types)
#   - mcp-tools/*/dist    (signal-tool + task-tool, spawned via stdio)
#   - dashboard/          (built static SPA, served by orchestra-core)
#   - orchestra-core/dist (the Fastify backend — the actual entrypoint)
#
# Build context is the workspace root (see docker-compose.yml). The
# previous Dockerfile only saw orchestra-core/ and assumed pre-built
# artifacts mounted at runtime — that broke deploys to a fresh server
# because nothing built the dashboard or the MCP tools on the host.

# ─── deps: install all workspace dependencies (dev + prod) ──────────────
FROM node:22-alpine AS deps
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/package.json
COPY orchestra-core/package.json orchestra-core/package.json
COPY dashboard/package.json dashboard/package.json
COPY mcp-tools/signal-tool/package.json mcp-tools/signal-tool/package.json
COPY mcp-tools/task-tool/package.json mcp-tools/task-tool/package.json

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ─── builder: compile shared + mcp-tools + dashboard + orchestra-core ──
FROM deps AS builder
COPY shared shared
COPY orchestra-core orchestra-core
COPY dashboard dashboard
COPY mcp-tools mcp-tools
RUN pnpm -r build

# ─── runtime: prod deps + compiled artifacts, no source ────────────────
FROM node:22-alpine AS runtime
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

# Install only production deps for the workspace. Dashboard is a build-only
# package and has no runtime, so we drop it from the install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/package.json
COPY orchestra-core/package.json orchestra-core/package.json
COPY mcp-tools/signal-tool/package.json mcp-tools/signal-tool/package.json
COPY mcp-tools/task-tool/package.json mcp-tools/task-tool/package.json
RUN --mount=type=cache,id=pnpm-prod,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter='!dashboard'

# Built JS — kept at the same relative paths as in the source tree so
# orchestra-core's `mcp-config-generator` (which resolves <cwd>/mcp-tools)
# and `db.ts` (which resolves __dirname/migrations) keep working.
COPY --from=builder /workspace/shared/dist shared/dist
COPY --from=builder /workspace/orchestra-core/dist orchestra-core/dist
COPY --from=builder /workspace/mcp-tools/signal-tool/dist mcp-tools/signal-tool/dist
COPY --from=builder /workspace/mcp-tools/task-tool/dist mcp-tools/task-tool/dist

# Built dashboard, served as static by orchestra-core (DASHBOARD_PATH env).
COPY --from=builder /workspace/dashboard/dist dashboard

# Content/config the orchestra reads at runtime via process.cwd().
COPY prompts prompts
COPY templates templates

# Legacy SQL migrations sit next to compiled db.js so the first candidate
# in db.ts's resolver (`__dirname/migrations`) hits without falling back.
COPY orchestra-core/src/migrations orchestra-core/dist/migrations

EXPOSE 3000

# /api/health is gated behind the same fastify instance — covers DB
# connectivity too (it does a `SELECT 1`). 20s start-period leaves room
# for migrations to apply on first boot.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "orchestra-core/dist/index.js"]
