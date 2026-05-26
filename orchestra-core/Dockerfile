# syntax=docker/dockerfile:1.7
#
# Multi-stage build that produces a single image containing every runtime
# piece of AI Orchestra:
#
#   - shared/dist             (built TypeScript types, imported as
#                              @ai-orchestra/shared by orchestra-core)
#   - mcp-tools/*/dist        (signal-tool + task-tool, spawned via stdio)
#   - dashboard/              (built static SPA, served by orchestra-core)
#   - orchestra-core/src      (run directly via `tsx`)
#
# orchestra-core is NOT pre-compiled. Its source uses extensionless ESM
# imports (moduleResolution=bundler) which Node's runtime ESM resolver
# rejects, so we'd have to either bundle, post-process compiled JS, or
# run via a TS loader. `tsx` does the last in one step and matches the
# dev runtime exactly — fewer ways for prod and dev to drift.

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
COPY mcp-tools/reference-tool/package.json mcp-tools/reference-tool/package.json

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ─── builder: type-check + build shared / mcp-tools / dashboard ─────────
# orchestra-core's "build" script is tsc with noEmit=true — type-check only.
FROM deps AS builder
COPY shared shared
COPY orchestra-core orchestra-core
COPY dashboard dashboard
COPY mcp-tools mcp-tools
RUN pnpm -r build

# ─── runtime: prod deps + compiled artifacts + orchestra-core source ───
FROM node:22-alpine AS runtime
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10 --activate

# Runtime CLIs orchestra-core spawns:
#   * git           — worktrees, branch ops
#   * claude/codex  — per-role agent runtimes + OAuth flows
#   * python3+pip   — direct execution of project scripts agents need to
#                     drive (e.g. ai-runner/runner.py for the AI/RAG MVP).
#                     Safe to ship — no privilege escalation, just an
#                     interpreter.
#   * go            — `go test ./...` against project backends written in
#                     Go (current AI/RAG backup-service). QA needs this
#                     to re-run unit tests inside the worktree. Safe to
#                     ship: a build/test runner with no privileged surface.
#   * curl          — QA validation scenarios hit local HTTP endpoints
#                     (e.g. `curl http://127.0.0.1:8443/api/v1/ai/status`).
#                     Without it the agent has to compose-and-fetch via
#                     node, which it doesn't reliably do.
#
# NOTE: docker-cli + docker-cli-compose were briefly included with a host
# docker.sock bind to let QA agents bring up project contours. That was
# revoked once multi-tenant became a requirement: a bound socket is root-
# equivalent on the host, breaking tenant isolation. QA contour validation
# now has to go through a sandboxed runner — see roadmap.
RUN apk add --no-cache git python3 py3-pip go curl \
 && npm i -g @openai/codex @anthropic-ai/claude-code

WORKDIR /app

# Install only production deps. Dashboard is build-only — drop it.
# tsx is in orchestra-core's `dependencies` (not devDeps) so it lands here.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/package.json
COPY orchestra-core/package.json orchestra-core/package.json
COPY mcp-tools/signal-tool/package.json mcp-tools/signal-tool/package.json
COPY mcp-tools/task-tool/package.json mcp-tools/task-tool/package.json
COPY mcp-tools/reference-tool/package.json mcp-tools/reference-tool/package.json
RUN --mount=type=cache,id=pnpm-prod,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter='!dashboard'

# shared/src — orchestra-core imports `@ai-orchestra/shared`, and that
# package's `exports` field points at ./src/index.ts (it's TS-source-only
# at the package boundary, with dist as a side-effect of `tsc`). Since
# orchestra-core runs via tsx, we ship the .ts files directly.
COPY shared/src shared/src

# Built JS for mcp-tools (spawned as stdio child processes by node, not tsx).
COPY --from=builder /workspace/mcp-tools/signal-tool/dist mcp-tools/signal-tool/dist
COPY --from=builder /workspace/mcp-tools/task-tool/dist mcp-tools/task-tool/dist
COPY --from=builder /workspace/mcp-tools/reference-tool/dist mcp-tools/reference-tool/dist

# Built dashboard, served as static by orchestra-core (DASHBOARD_PATH env).
COPY --from=builder /workspace/dashboard/dist dashboard

# orchestra-core source — tsx executes this directly. Faster than bundling
# and avoids the extensionless-import issue from a tsc emit.
COPY orchestra-core/src orchestra-core/src
COPY orchestra-core/tsconfig.json orchestra-core/tsconfig.json

# Content/config the orchestra reads at runtime via process.cwd().
COPY prompts prompts
COPY templates templates

# orchestra-core's cwd-based lookups (role-definitions prompt loader,
# session-context) read `<cwd>/prompts/...`. Set cwd to /app/orchestra-core
# (so `pnpm exec tsx` resolves), then symlink the cwd-relative paths back
# to the workspace root copies. mcp-config-generator's `<cwd>/../mcp-tools`
# fallback already finds /app/mcp-tools without help.
RUN ln -s /app/prompts /app/orchestra-core/prompts \
 && ln -s /app/templates /app/orchestra-core/templates

WORKDIR /app/orchestra-core

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=25s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["pnpm", "exec", "tsx", "src/index.ts"]
