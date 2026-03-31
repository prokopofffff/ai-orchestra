# AI Orchestra

Self-hosted AI agent orchestrator that simulates a full development team. You communicate with a single **Tech Lead** agent through Telegram, manage tasks via a **web dashboard with kanban board**, and agents coordinate autonomously — powered by Claude Code with [Superpowers](https://github.com/obra/superpowers) plugin.

Inspired by [Paperclip](https://github.com/paperclipai/paperclip), but with more control: explicit roles, Flow Guard for hard signal validation, built-in task tracker, and transparent inter-agent communication.

## How it works

```
You (Telegram + Dashboard)
     |
     v
 Tech Lead ---- creates tasks in built-in tracker
     |              writes technical specs
     |              reviews PRs via subagent
     |
     +---> Designer + Backend Dev  (in parallel)
     |         |            |
     |    design_ready       |
     |         |            |
     |    Frontend Dev       |
     |         |            |
     +---> QA (writes tests for each PR)
     |         |
     |    tests_passed
     |         |
     +---> Tech Lead reviews --> You merge (or delegate)
```

- **Tech Lead** (long-lived session) — combines PM + CTO: clarifies requirements, creates tasks, writes specs, assigns agents, reviews PRs
- **Designer** (per-task) — creates UI mockups in Pencil (.pen files), maintains a project-wide design system
- **Frontend Dev** (per-task) — implements UI from designs, TDD, creates PRs
- **Backend Dev** (per-task) — implements API/logic, TDD, creates PRs
- **QA Tester** (per-task) — writes tests after developer PR, verifies acceptance criteria
- **DevOps** (per-task) — sets up CI/CD pipelines and deploys to user-specified infrastructure

## Architecture

```
docker-compose.yml
├── postgres         — shared database (sessions, tasks, signals, flow audit)
└── orchestra-core   — single service: API, session manager, task tracker,
                       flow guard, webhooks, dashboard (port 3000)
```

**Flow Guard** validates every signal between agents — who can talk to whom, what actions are allowed, and enforces a 13-state task state machine. Violations return 403 with reason and are logged to the audit trail.

See [docs/architecture.md](docs/architecture.md) for the full design.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI with an active subscription
- [Superpowers](https://github.com/obra/superpowers) plugin installed (`claude plugins install superpowers@claude-plugins-official`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- GitHub or GitLab personal access token (with repo, org, PR permissions)

## Quick start

### 1. Clone and configure

```bash
git clone https://github.com/prokopofffff/ai-orchestra.git
cd ai-orchestra
cp .env.example .env
```

Edit `.env` with your credentials:

```env
POSTGRES_PASSWORD=your_secure_password
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id
GIT_PROVIDER=github
GIT_TOKEN=ghp_your_token
GIT_ORG=your-org
```

### 2. Build and start

```bash
pnpm install
pnpm run build
docker compose up -d
```

### 3. Open dashboard

Go to http://localhost:3000 — create a project, add tasks, monitor agents.

### 4. Set up Telegram webhook (optional)

For receiving messages from Telegram, expose port 3000 publicly (ngrok, Cloudflare Tunnel) and set the webhook:

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=https://your-domain.com/api/telegram/webhook"
```

## Project structure

```
ai-orchestra/
├── orchestra-core/src/          # Core service (TypeScript)
│   ├── index.ts                 # Express server
│   ├── session-manager.ts       # Claude Code session lifecycle
│   ├── agent-spawner.ts         # Agent creation, git branches, bootstrap
│   ├── signal-api.ts            # Inter-agent signal API + Flow Guard
│   ├── flow-guard.ts            # Allowed routes, actions, state machine, audit
│   ├── task-api.ts              # Built-in task tracker (CRUD)
│   ├── rate-limiter.ts          # Priority queue for rate limits
│   ├── session-context.ts       # Bootstrap context from summaries + tasks
│   ├── mcp-config-generator.ts  # Per-role MCP config
│   ├── webhooks.ts              # Telegram + GitHub/GitLab webhooks
│   ├── notify.ts                # Telegram Bot API notifications
│   ├── db-utils.ts              # DB row mapping helper
│   ├── setup-wizard.ts          # CLI first-time setup
│   └── config.ts                # Zod-validated configuration
├── mcp-tools/
│   ├── signal-tool/src/         # MCP: signal_agent(), notify_user()
│   └── task-tool/src/           # MCP: task_create, task_update, etc.
├── dashboard/src/               # React web UI
│   ├── components/
│   │   ├── AgentGraph.tsx       # SVG agent schema
│   │   ├── KanbanBoard.tsx      # Kanban board with task cards
│   │   ├── TaskDetail.tsx       # Task detail modal
│   │   ├── SignalFeed.tsx       # Audit log feed
│   │   ├── CreateForms.tsx      # Project/task creation forms
│   │   └── ...
│   └── ...
├── prompts/                     # System prompts per role
└── templates/                   # Project scaffolding templates
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/signal` | Send a signal between agents (Flow Guard validated) |
| POST | `/api/signal/dispatch` | Dispatch an agent for a task |
| GET | `/api/signal/pending/:role` | Get unprocessed signals |
| GET | `/api/signal/history` | Signal history |
| POST | `/api/spawn` | Spawn an agent with rate limiting |
| GET | `/api/sessions` | List all sessions |
| DELETE | `/api/sessions/:id` | Terminate a session |
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create project |
| GET | `/api/tasks` | List tasks (filter by project, state, type) |
| POST | `/api/tasks` | Create task |
| PATCH | `/api/tasks/:id` | Update task |
| DELETE | `/api/tasks/:id` | Delete task |
| GET/POST | `/api/tasks/:id/comments` | Task comments |
| GET | `/api/flow/audit` | Flow Guard audit log |
| GET | `/api/flow/violations` | Rejected signals only |
| GET | `/api/queue` | Rate-limited task queue |
| POST | `/api/telegram/webhook` | Telegram Bot API webhook |
| POST | `/api/git/webhook` | GitHub/GitLab webhook |
| GET | `/health` | Health check |

## Flow Guard

Every signal is validated before routing:

- **Allowed routes** — frontend cannot signal backend directly (must go through tech-lead)
- **Allowed actions** — dev cannot deploy, designer cannot approve PRs
- **State machine** — cannot assign dev before design is ready (for UI tasks)
- **Audit log** — every signal logged with allowed/rejected status and reason

## Rate limiting

When Claude subscription limits are hit, tasks are queued with priorities:

| Priority | Role |
|----------|------|
| 100 | Tech Lead |
| 50 | Designer |
| 40 | Frontend / Backend Dev |
| 30 | QA |
| 20 | DevOps |

## License

MIT
