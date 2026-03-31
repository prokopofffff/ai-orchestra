# AI Orchestra

Self-hosted AI agent orchestrator that simulates a full development team. You communicate with a single **Tech Lead** agent through Telegram, and it coordinates Designers, Frontend/Backend Developers, QA Testers, and DevOps engineers — all powered by Claude Code with [Superpowers](https://github.com/obra/superpowers) plugin.

Inspired by [Paperclip](https://github.com/paperclipai/paperclip), but with more control: explicit roles, event-driven architecture, a real task tracker, and transparent inter-agent communication.

## How it works

```
You (Telegram)
     |
     v
 Tech Lead ---- creates tasks in OpenProject
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
├── postgres         — shared database
├── n8n              — central orchestrator (workflows, webhooks, cron)
├── openproject      — task tracker (Epics, Tasks, Subtasks)
├── openclaw         — Telegram bridge
└── orchestra-core   — session manager, signal API, agent spawner
```

Agents communicate through a **Signal System**: an agent calls `signal_agent(to, action, message)` via MCP tool, which hits the orchestra-core API, gets logged to OpenProject, routed by n8n, and mirrored to your Telegram.

Session management uses the **A+C model**: sessions resume within 8 hours or while the project context hasn't changed. After that, a fresh session bootstraps from the last summary + OpenProject state + pending signals.

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
# Required
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
GIT_PROVIDER=github          # or gitlab
GIT_TOKEN=ghp_your_token
GIT_ORG=your-org              # optional

# Optional (defaults work for local setup)
POSTGRES_PASSWORD=orchestra_secret
N8N_USER=admin
N8N_PASSWORD=admin
OPENPROJECT_SECRET=change_me_to_a_long_random_string
```

### 2. Build and start

```bash
pnpm install
pnpm run build
docker compose up -d
```

Wait for all services to start (~1-2 minutes for OpenProject on first run).

### 3. Setup wizard

```bash
cd orchestra-core
pnpm run setup
```

The wizard will:
- Verify Claude CLI and Superpowers plugin
- Configure Git provider credentials
- Set up Telegram bot connection
- Optionally create your first project

### 4. Configure n8n workflows

Open n8n at `http://localhost:5678` (login: admin/admin) and import the workflows:

- `n8n/workflows/signal-router.json` — routes signals between agents
- `n8n/workflows/git-webhooks.json` — handles GitHub/GitLab PR events
- `n8n/workflows/session-lifecycle.json` — cleans up stale sessions, processes queue
- `n8n/workflows/telegram-to-tech-lead.json` — routes Telegram messages to Tech Lead

Activate all workflows after importing.

### 5. Configure OpenProject

Open OpenProject at `http://localhost:8080`, create an admin account, then:

1. Go to **Administration > API** and generate an API key
2. Add it to your `.env` as `OPENPROJECT_API_KEY=your_key`
3. Restart orchestra-core: `docker compose restart orchestra-core`

### 6. Start chatting

Send a message to your Telegram bot. The Tech Lead will respond, ask clarifying questions about your project, and start creating tasks.

## Project structure

```
ai-orchestra/
├── orchestra-core/src/          # Core service (TypeScript)
│   ├── index.ts                 # Express server
│   ├── session-manager.ts       # Claude Code session lifecycle
│   ├── agent-spawner.ts         # Agent creation, git branches, bootstrap
│   ├── signal-api.ts            # Inter-agent signal REST API
│   ├── rate-limiter.ts          # Priority queue for rate limits
│   ├── session-context.ts       # Bootstrap context from summaries + OpenProject
│   ├── mcp-config-generator.ts  # Per-role MCP config (Pencil for designer/frontend)
│   ├── notify.ts                # Telegram delivery via OpenClaw
│   ├── setup-wizard.ts          # CLI first-time setup
│   └── config.ts                # Zod-validated configuration
├── mcp-tools/
│   ├── signal-tool/src/         # MCP: signal_agent(), notify_user()
│   └── openproject-tool/src/    # MCP: task CRUD, comments
├── prompts/                     # System prompts per role
│   ├── tech-lead.md
│   ├── designer.md
│   ├── dev-frontend.md
│   ├── dev-backend.md
│   ├── qa.md
│   └── devops.md
├── n8n/workflows/               # n8n workflow definitions
├── templates/                   # Project scaffolding templates
├── openclaw/config.yaml         # Telegram bridge config
└── docker-compose.yml
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/signal` | Send a signal between agents |
| POST | `/api/signal/dispatch` | Dispatch an agent for a task |
| GET | `/api/signal/pending/:role` | Get unprocessed signals |
| GET | `/api/signal/history` | Signal history |
| POST | `/api/spawn` | Spawn an agent with rate limiting |
| GET | `/api/sessions` | List all sessions |
| GET | `/api/sessions/:id` | Get session details |
| DELETE | `/api/sessions/:id` | Terminate a session |
| GET | `/api/queue` | View rate-limited task queue |
| GET | `/health` | Health check |

## Superpowers skills per role

| Skill | Tech Lead | Designer | Frontend | Backend | QA | DevOps |
|-------|:-:|:-:|:-:|:-:|:-:|:-:|
| brainstorming | + | + | | | | |
| writing-plans | + | | | | | |
| subagent-driven-development | + | | + | + | | |
| executing-plans | | | + | + | | + |
| dispatching-parallel-agents | + | | | | | |
| test-driven-development | | | + | + | + | |
| systematic-debugging | | | + | + | + | + |
| verification-before-completion | + | + | + | + | + | + |
| requesting-code-review | + | | + | + | | |
| receiving-code-review | | | + | + | | |
| finishing-a-development-branch | | | + | + | + | + |
| using-git-worktrees | | | + | + | + | + |
| writing-skills | + | | | | | |
| Pencil MCP | | all | read | | | |

## Rate limiting

When Claude subscription limits are hit, tasks are queued with priorities:

| Priority | Role |
|----------|------|
| 100 | Tech Lead |
| 50 | Designer |
| 40 | Frontend / Backend Dev |
| 30 | QA |
| 20 | DevOps |

The session lifecycle cron (every 5 min) processes the queue when limits recover.

## License

MIT
