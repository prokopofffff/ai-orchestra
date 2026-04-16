# AI Orchestra

Orchestrator for autonomous AI development teams. Manages a pool of Claude-powered agents (tech-lead, designer, frontend, backend, QA, devops) that collaborate on tasks through a signal-based flow, with full PR lifecycle support for GitHub and GitLab.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌────────────┐
│  Dashboard   │────▶│ orchestra-core│────▶│  Postgres  │
│  (React)     │     │  (Fastify)   │     │   Docker   │
└─────────────┘     │              │     └────────────┘
                    │  ┌──────────┐│          │
                    │  │Scheduler ││     ┌────────────┐
                    │  │(graphile)││     │ Claude SDK │
                    │  └──────────┘│────▶│  (agents)  │
                    │  ┌──────────┐│     └────────────┘
                    │  │Providers ││
                    │  │(GH + GL) ││
                    │  └──────────┘│
                    └──────────────┘
```

**Workspace packages:**

| Package | Purpose |
|---|---|
| `orchestra-core` | Fastify API, scheduler, agent spawner, flow engine |
| `dashboard` | React SPA — Kanban, chat, signals, flow diagram, logs, settings |
| `shared` (`@ai-orchestra/shared`) | Zod schemas, flow definition, Mermaid renderers |
| `mcp-tools/*` | MCP servers for agent ↔ orchestrator communication |

## Tech stack

| Layer | Technology |
|---|---|
| API server | Fastify (pino logging native) |
| Database | PostgreSQL 16 + Drizzle ORM (schema-as-TS, drizzle-kit migrations) |
| Job scheduler | graphile-worker (Postgres-backed, cron + one-shot + rate-limit buckets) |
| Agent runtime | Claude Agent SDK (in-process, `query()` with hooks + `canUseTool` scope) |
| Dashboard | React + TanStack Query + Mermaid (lazy-loaded) + Vite |
| Shared types | `@ai-orchestra/shared` — Zod schemas + flow definition |
| Git providers | GitHub + GitLab (per-project, self-hosted supported) |
| Linting | ESLint flat config + typescript-eslint |
| Testing | Vitest (backend 324 tests, dashboard 61 tests) |

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 10
- **Docker** (for Postgres) OR a Postgres 16+ instance
- **Claude Code** installed and logged in (`claude login`)

## Quick start

```bash
# 1. Clone + install
git clone https://github.com/prokopofffff/ai-orchestra.git
cd ai-orchestra
pnpm install

# 2. Start Postgres
docker compose up -d postgres

# 3. Configure environment
cp .env.example .env
# Edit .env — at minimum set GITHUB_TOKEN or GITLAB_TOKEN

# 4. Build the dashboard
pnpm --filter dashboard build

# 5. Run the setup wizard (creates first project interactively)
pnpm setup

# 6. Start the orchestrator
pnpm dev
# → http://localhost:3000
```

## Environment variables

Create a `.env` file in the project root:

```bash
# ─── Required ─────────────────────────────────────────────
DATABASE_URL=postgres://orchestra:orchestra_secret@127.0.0.1:5434/orchestra

# ─── Claude authentication (pick one) ────────────────────
CLAUDE_AUTH=max                # "max" for subscription, "api" for API key
# CLAUDE_API_KEY=sk-ant-...   # only needed if CLAUDE_AUTH=api

# ─── Git provider (global fallback — per-project tokens override) ──
GITHUB_TOKEN=ghp_...           # GitHub PAT with repo scope
# GITLAB_TOKEN=glpat_...       # GitLab PAT with api scope

# ─── Optional ─────────────────────────────────────────────
GITHUB_DEFAULT_ORG=your-org
GITHUB_DEFAULT_BRANCH=main

# Telegram notifications
# TELEGRAM_BOT_TOKEN=...
# TELEGRAM_CHAT_ID=...

# Per-role model overrides (defaults: tech-lead=opus, others=sonnet)
# MODEL_TECH_LEAD=opus
# MODEL_DESIGNER=sonnet
# MODEL_FRONTEND=sonnet
# MODEL_BACKEND=sonnet
# MODEL_QA=sonnet
# MODEL_DEVOPS=sonnet

# Pencil design tool integration
# PENCIL_ENABLED=true
# PENCIL_MODEL=claude-sonnet-4-6

# Observability
# LOG_LEVEL=debug              # pino level: debug | info | warn | error
```

## Per-project Git provider configuration

Each project can override the global token and target a different provider (GitHub, GitLab, or self-hosted):

```bash
# Via API:
curl -X PATCH http://localhost:3000/api/projects/<id> \
  -H 'Content-Type: application/json' \
  -d '{
    "settings": {
      "provider": {
        "type": "gitlab",
        "token": "glpat_project_specific_token",
        "baseUrl": "https://gitlab.company.internal"
      }
    }
  }'
```

Or via the **Settings** tab in the dashboard.

If `type` is omitted, the provider is auto-detected from the repo URL hostname. If `token` is omitted, the global `GITHUB_TOKEN` or `GITLAB_TOKEN` env is used.

## Development

```bash
# Start everything for local dev
docker compose up -d postgres
pnpm dev                         # → orchestrator on :3000
pnpm --filter dashboard dev      # → Vite dev server on :5173 (proxies /api → :3000)

# Lint
pnpm lint
pnpm lint:fix

# Test
pnpm --filter orchestra-core test
pnpm --filter dashboard test

# Database schema changes (going forward — use Drizzle, not raw SQL)
# 1. Edit orchestra-core/src/db/schema.ts
# 2. Generate migration:
pnpm --filter orchestra-core db:generate
# 3. Review the SQL in orchestra-core/drizzle/
# 4. Commit both files. Migration applies on next boot.

# Open Drizzle Studio (DB browser)
pnpm --filter orchestra-core db:studio
```

## Agent flow

The lifecycle of a task through the agent team:

```
new → described → designing → design_ready → in_development → pr_created
  → in_testing → tested → in_review → approved → merged → closed
```

With side-loops for revisions (`pr_created ↔ revisions`), failures (`* → failed`), and cancellation.

The flow is defined declaratively in [`shared/src/flow.ts`](shared/src/flow.ts) — one `Edge[]` array that drives:
- Backend signal validation (`flow-guard`)
- Backend dispatch routing (`dispatcher`)
- Dashboard Flow tab (Mermaid state diagram + role graph)

Add a new action = one entry in the array; validation + dispatch + visualization all update.

## Observe hooks

Each agent role has configurable checks that run after every `Edit` / `Write` tool use:

| Role | Default checks |
|---|---|
| frontend | `tsc --noEmit`, `eslint` |
| backend | `tsc --noEmit`, `eslint` |
| qa | `tsc --noEmit`, `vitest run` (alert severity) |
| designer, devops, tech-lead | none |

Checks run asynchronously via the scheduler — they don't block the agent. Results land in `agent_logs`. Checks with `onFail: "alert"` also insert a `system → tech-lead notify` signal.

Override per-project via the **Settings** tab or:

```bash
curl -X PATCH http://localhost:3000/api/projects/<id> \
  -H 'Content-Type: application/json' \
  -d '{
    "settings": {
      "checks": {
        "backend": [
          { "name": "ci", "pattern": "src/**/*.ts", "command": "pnpm ci", "onFail": "alert" }
        ]
      }
    }
  }'
```

## Webhook setup

Point your GitHub/GitLab project webhook at:

| Provider | URL | Content type |
|---|---|---|
| GitHub | `https://<host>/api/git/webhook/github` | `application/json` |
| GitLab | `https://<host>/api/git/webhook/gitlab` | `application/json` |
| Auto-detect | `https://<host>/api/git/webhook` | `application/json` |

Events to subscribe: **Push**, **Pull Request** / **Merge Request**.

## Docker (production)

```bash
# Build + run everything
docker compose up -d --build

# The orchestrator serves the dashboard as static files from /app/dashboard.
# → http://localhost:3000
```

## Project structure

```
ai-orchestra/
├── shared/                    # @ai-orchestra/shared — Zod schemas, flow, Mermaid
│   └── src/
│       ├── index.ts           # Domain schemas + types
│       ├── flow.ts            # Edge[] — declarative agent flow
│       └── flow-mermaid.ts    # State diagram + role graph renderers
├── orchestra-core/            # Fastify API + scheduler + agents
│   ├── src/
│   │   ├── index.ts           # Boot: migrations, scheduler, Fastify
│   │   ├── db/schema.ts       # Drizzle schema (source of truth for DDL)
│   │   ├── scheduler.ts       # graphile-worker wrapper
│   │   ├── obs.ts             # pino + AsyncLocalStorage observability
│   │   ├── providers/         # GitHub + GitLab abstraction
│   │   ├── agents/            # SDK runner, per-role configs, observe hooks
│   │   ├── flow-guard.ts      # Signal validation (from shared flow)
│   │   ├── dispatcher.ts      # Signal dispatch (from shared flow)
│   │   └── ...                # API routes, session mgmt, heartbeat, etc.
│   ├── prompts/               # System prompts per role
│   ├── drizzle/               # Auto-generated migrations (drizzle-kit)
│   └── drizzle.config.ts
├── dashboard/                 # React SPA
│   └── src/
│       ├── components/        # Kanban, Chat, Flow, Settings, Logs, …
│       ├── api.ts             # Typed + runtime-validated API client
│       └── types.ts           # Re-exports from @ai-orchestra/shared
├── mcp-tools/                 # MCP servers (signal-tool, task-tool)
├── docker-compose.yml
├── eslint.config.js
└── pnpm-workspace.yaml
```

## License

Private.
