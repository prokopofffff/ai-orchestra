# AI Orchestra — Архитектура оркестратора AI-агентов

## Context

Цель — создать систему оркестрации AI-агентов, имитирующую команду разработки. Пользователь общается с Tech Lead через Telegram и управляет проектом через web dashboard. Агенты-разработчики выполняют задачи автономно. В отличие от Paperclip, система даёт больше контроля: чёткие роли, Flow Guard для валидации межагентного взаимодействия, встроенный task tracker с kanban board.

---

## Компоненты системы

### Инфраструктура (Docker Compose)

```
docker-compose.yml
├── postgres         — БД (сессии, задачи, сигналы, flow audit)
└── orchestra-core   — единый сервис: API, session manager, task tracker,
                       flow guard, webhooks, dashboard (порт 3000)
```

### orchestra-core (единый сервис)

- **Session Manager** — управление сессиями Claude Code (создание, resume, завершение)
- **Signal API + Flow Guard** — межагентная коммуникация с жёсткой валидацией маршрутов и действий
- **Task API** — встроенный task tracker (проекты, задачи, комментарии)
- **Agent Spawner** — создание агентов с git branch, bootstrap контекст, per-role MCP config
- **Rate Limiter** — очередь задач с приоритетами при rate limit подписки Claude
- **Webhooks** — Telegram Bot API и GitHub/GitLab webhooks напрямую
- **Dashboard** — React SPA (kanban board, agent graph, signal feed)

### Агенты

| Роль | Тип сессии | Когда запускается |
|------|-----------|-------------------|
| Tech Lead | Долгоживущая (A+C) | Telegram сообщение, сигнал от Dev/QA/Designer, PR webhook, cron |
| Designer | Per-task (с памятью через design system) | Сигнал create_design / create_design_system от Tech Lead |
| Frontend Dev | Per-task | Назначение задачи от Tech Lead (после design_ready) |
| Backend Dev | Per-task | Назначение задачи от Tech Lead (параллельно с Designer) |
| QA/Tester | Per-task | PR создан разработчиком |
| DevOps | Per-task | Задача на CI/CD или деплоймент |

### Tech Lead — объединённая роль PM + CTO

Tech Lead работает в двух режимах в зависимости от события:

**Режим "product":**
- Уточняет фичу с пользователем через Telegram
- Создаёт Epic и задачи в task tracker
- Назначает разработчиков
- Отслеживает прогресс, уведомляет пользователя

**Режим "technical":**
- Пишет техническое описание задач, acceptance criteria
- Определяет параллельность задач для разработчиков
- Проектирует архитектуру, описывает стек и конвенции
- Настраивает CLAUDE.md проекта

**Ревью PR** — для объективности Tech Lead использует skill `requesting-code-review`
из Superpowers, который спавнит отдельный subagent-reviewer без bias.

---

## Flow Guard — контроль межагентного взаимодействия

Жёсткая валидация на уровне API (не промптов). Агент физически не может отправить невалидный сигнал.

### Allowed routes (кто → кому)

```
tech-lead  → designer, frontend, backend, qa, devops, user
designer   → tech-lead, user
frontend   → tech-lead, qa, user
backend    → tech-lead, qa, user
qa         → tech-lead, user
devops     → tech-lead, user
```

Запрещено: dev → dev напрямую, designer → dev, qa → dev.

### Allowed actions (кто → что)

Каждая роль имеет ограниченный набор допустимых actions. Например:
- `frontend` может: `pr_created`, `question`, `escalate`, `notify`
- `frontend` НЕ может: `deploy`, `assign_dev`, `pr_approved`

### State Machine задачи (13 состояний)

```
new → described → designing → design_ready → in_development → pr_created
                                               → in_testing → tested → in_review
                                               → approved → merged → closed
```

Переходы валидируются — нельзя `assign_dev` до `design_ready`, нельзя `tests_passed` до `in_testing`.

### Audit Log

Каждый сигнал логируется (allowed/rejected + reason). Доступно через:
- `GET /api/flow/audit` — полный лог
- `GET /api/flow/violations` — только отклонённые
- Dashboard → Signal Feed (визуально)

---

## Встроенный Task Tracker

Заменяет OpenProject. PostgreSQL таблицы: `projects`, `tasks`, `task_comments`.

### API

- `GET/POST /api/projects` — проекты
- `GET/POST/PATCH/DELETE /api/tasks` — задачи с фильтрами (project, state, type)
- `GET/POST /api/tasks/:id/comments` — комментарии

### Типы задач

Epic, Task, Subtask, Bug, Feature

### Приоритеты

Low, Normal, High, Immediate

### Состояния (= колонки канбана)

Группировка по фазам:
- **Backlog**: new, described
- **Design**: designing, design_ready
- **Development**: in_development, pr_created
- **Testing**: in_testing, tested
- **Review**: in_review, approved
- **Done**: merged, closed

### MCP tool для агентов

`mcp-tools/task-tool/` — MCP сервер с инструментами:
- `task_create`, `task_update`, `task_get`, `task_list`, `task_add_comment`
- `project_create`, `project_list`

---

## Dashboard (Web UI)

React SPA на http://localhost:3000. Polling каждые 5 сек.

### Компоненты

- **Agent Graph** — SVG схема 6 ролей с связями и live-статусами
- **Signal Feed** — лента audit log (allowed/rejected сигналы)
- **Kanban Board** — задачи по колонкам-фазам, кликабельные карточки
- **Task Detail Modal** — редактирование state/priority/assignee, description, комментарии, удаление
- **Project Selector** — выбор/создание проекта
- **Create Task Form** — создание задач
- **Agent Cards** — активные сессии
- **Task Queue** — rate-limited задачи в очереди

---

## Управление сессиями

### Session Manager

```typescript
type AgentRole = "tech-lead" | "designer" | "frontend" | "backend" | "qa" | "devops";
type SessionStatus = "running" | "sleeping" | "terminated";
```

**Модель A+C (resume vs new):**
- A: таймаут 8 часов → новая сессия
- C: смена фазы проекта → новая сессия
- При resume: `claude --resume ${session_id}`
- При new: bootstrap контекст (last summary + текущие задачи + pending сигналы)

### Agent Spawner

- Создаёт git branch per task (`feature/frontend/{taskId}`, `design/{taskId}`, etc.)
- Генерирует per-role MCP config (Pencil MCP для designer/frontend)
- Bootstrap контекст из session summaries + задач + pending сигналов
- Retry с exponential backoff (до 2 попыток)
- Уведомление пользователя при failure

### Rate Limiter

Приоритеты очереди:
| Приоритет | Роль |
|-----------|------|
| 100 | Tech Lead |
| 50 | Designer |
| 40 | Frontend / Backend |
| 30 | QA |
| 20 | DevOps |

Состояние в PostgreSQL (persistent). Reconciliation при рестарте.

---

## Межагентная коммуникация (Signal System)

### Signal API

```
POST /api/signal
{
  "from": "frontend",
  "to": "tech-lead",
  "action": "question",
  "context": {
    "project_id": "my-app",
    "task_id": "abc123",
    "message": "Какой роутер использовать?"
  }
}
```

Flow Guard валидирует → логирует → обновляет state machine → dispatch агент.

### Типы сигналов

| action | from → to | Описание |
|--------|-----------|----------|
| `create_design_system` | Tech Lead → Designer | Создать design system проекта |
| `create_design` | Tech Lead → Designer | Создать дизайн экрана для задачи |
| `design_system_ready` | Designer → Tech Lead | Design system готов |
| `design_ready` | Designer → Tech Lead | Дизайн экрана готов |
| `assign_dev` | Tech Lead → Dev | Назначить разработчика на задачу |
| `question` | Dev/Designer → Tech Lead | Вопрос по архитектуре/дизайну |
| `answer` | Tech Lead → Dev/Designer | Ответ на вопрос |
| `pr_created` | Dev → QA | PR готов, нужны тесты |
| `tests_passed` | QA → Tech Lead | Тесты написаны и зелёные |
| `pr_approved` | Tech Lead → User | PR одобрен, готов к мержу |
| `pr_changes_requested` | Tech Lead → Dev | Нужны правки в PR |
| `task_done` | Tech Lead → User | Задача завершена |
| `escalate` | Any → User | Вопрос пользователю |
| `deploy` | Tech Lead → DevOps | Задеплоить проект |
| `setup_cicd` | Tech Lead → DevOps | Настроить CI/CD |

---

## Webhooks (встроенные)

### Telegram
```
POST /api/telegram/webhook
← Telegram Bot API update
→ Dispatch Tech Lead с текстом сообщения
```

### GitHub/GitLab
```
POST /api/git/webhook
← PR opened → Dispatch QA
← PR review → Notify Tech Lead
← Push → Notify user via Telegram
```

---

## Полный жизненный цикл фичи

```
                       Пользователь (Telegram / Dashboard)
                              │
                    ┌─────────▼──────────┐
                    │     Tech Lead      │
                    │  [режим product]   │
                    │  • Уточняет детали │
                    │  • Создаёт Epic    │
                    │  • Создаёт задачи  │
                    │                    │
                    │  [режим technical] │
                    │  • Тех. описание   │
                    │  • Acceptance crit. │
                    │  • Определяет      │
                    │    параллельность   │
                    └──┬─────────────┬───┘
                       │             │
     signal: create_design    signal: assign_dev
                       │             │
              ┌────────▼───┐  ┌──────▼────────┐
              │  Designer  │  │  Dev-Backend  │  (параллельно)
              │ • design   │  │  • ветка      │
              │   system   │  │  • код        │
              │ • макеты   │  │  • PR         │
              │ • .pen     │  └──────┬────────┘
              └────────┬───┘         │
                       │             │
          signal: design_ready       │
                       │             │
              ┌────────▼───┐         │
              │ Dev-Frontend│         │
              │ • читает   │         │
              │   дизайн   │         │
              │ • ветка    │         │
              │ • код      │         │
              │ • PR       │         │
              └────────┬───┘         │
                       │             │
          signal: pr_created    signal: pr_created
                       │             │
              ┌────────▼───┐  ┌──────▼────────┐
              │  QA (front) │  │  QA (back)    │  (параллельно)
              │ • тесты     │  │  • тесты      │
              │ • проверка  │  │  • проверка   │
              └────────┬───┘  └──────┬────────┘
                       │             │
          signal: tests_passed  signal: tests_passed
                       │             │
              ┌────────▼─────────────▼────────┐
              │         Tech Lead             │
              │  [режим technical]            │
              │  • Ревью PR (через subagent)  │
              │  • Approve / Request changes  │
              │                               │
              │  [режим product]              │
              │  • Уведомляет user            │
              │  • User мержит (или TL)       │
              └───────────────────────────────┘
```

---

## Superpowers Skills — распределение по ролям

| Skill | Tech Lead | Designer | Frontend Dev | Backend Dev | QA | DevOps |
|-------|:---------:|:--------:|:------------:|:-----------:|:--:|:------:|
| **using-superpowers** | + | + | + | + | + | + |
| **brainstorming** | + | + | — | — | — | — |
| **writing-plans** | + | — | — | — | — | — |
| **subagent-driven-development** | + | — | + | + | — | — |
| **executing-plans** | — | — | + | + | — | + |
| **dispatching-parallel-agents** | + | — | — | — | — | — |
| **test-driven-development** | — | — | + | + | + | — |
| **systematic-debugging** | — | — | + | + | + | + |
| **verification-before-completion** | + | + | + | + | + | + |
| **requesting-code-review** | + | — | + | + | — | — |
| **receiving-code-review** | — | — | + | + | — | — |
| **finishing-a-development-branch** | — | — | + | + | + | + |
| **using-git-worktrees** | — | — | + | + | + | + |
| **writing-skills** | + | — | — | — | — | — |
| **Pencil MCP tools** | — | + (all) | + (read) | — | — | — |

---

## Структура проекта

```
ai-orchestra/
├── docker-compose.yml
├── orchestra-core/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                # Express сервер, роутинг
│       ├── config.ts               # Zod-валидация конфигурации
│       ├── session-manager.ts      # CRUD сессий, launch/resume Claude Code
│       ├── agent-spawner.ts        # Создание агентов, git branch, bootstrap
│       ├── signal-api.ts           # Signal REST API + Flow Guard интеграция
│       ├── flow-guard.ts           # Allowed routes, actions, state machine, audit
│       ├── task-api.ts             # Встроенный task tracker (CRUD)
│       ├── rate-limiter.ts         # Очередь с приоритетами (persistent)
│       ├── session-context.ts      # Bootstrap контекст из summaries + задач
│       ├── mcp-config-generator.ts # Per-role MCP config
│       ├── webhooks.ts             # Telegram + GitHub/GitLab webhooks
│       ├── notify.ts               # Telegram Bot API notifications
│       ├── db-utils.ts             # parseRow/parseRows (snake→camel + Zod)
│       └── setup-wizard.ts         # CLI первоначальная настройка
├── mcp-tools/
│   ├── mcp-config.json
│   ├── signal-tool/src/index.ts    # MCP: signal_agent(), notify_user()
│   └── task-tool/src/index.ts      # MCP: task_create, task_update, etc.
├── dashboard/
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── App.tsx                 # Главный layout
│       ├── api.ts                  # Fetch wrapper для API
│       ├── types.ts                # TypeScript типы
│       ├── hooks/usePolling.ts     # Generic polling hook
│       └── components/
│           ├── AgentGraph.tsx      # SVG схема агентов
│           ├── AgentCards.tsx      # Карточки активных сессий
│           ├── SignalFeed.tsx      # Лента audit log
│           ├── KanbanBoard.tsx     # Канбан доска
│           ├── TaskDetail.tsx      # Модалка деталей задачи
│           ├── TaskQueue.tsx       # Очередь rate-limited задач
│           └── CreateForms.tsx     # Формы создания проекта/задачи
├── prompts/
│   ├── tech-lead.md
│   ├── designer.md
│   ├── dev-frontend.md
│   ├── dev-backend.md
│   ├── qa.md
│   └── devops.md
└── templates/
    ├── CLAUDE.md.template
    └── .gitignore.template
```

---

## Память агентов

### При завершении сессии (Tech Lead)

```
docs/sessions/tech-lead-{date}-{n}.md
---
role: tech-lead
project: my-app
session_id: abc123
---
## Summary
- Что было сделано

## Архитектурные решения
- Какие решения приняты и почему

## Открытые вопросы
- Что нужно уточнить у пользователя
```

### При bootstrap новой сессии

orchestra-core собирает:
1. Последний session summary для роли
2. Текущие задачи из task tracker
3. Непрочитанные сигналы (атомарно помечаются прочитанными)
4. Design system (STYLE.md) для designer

---

## Верификация / Как тестировать

1. `docker compose up -d` — postgres + orchestra-core поднимаются
2. Dashboard на http://localhost:3000 — создать проект, задачи
3. Telegram → отправить сообщение боту → Tech Lead dispatched
4. Flow Guard — отклоняет невалидные сигналы с 403
5. Kanban — задачи отображаются по колонкам, кликабельные
6. Signal Feed — видны все сигналы (allowed/rejected)

---

## Планы на будущее

- [ ] Telegram webhook через публичный URL (ngrok / Cloudflare Tunnel)
- [ ] End-to-end test: полный цикл фичи от Telegram до merge
- [ ] Git PR creation через GitHub/GitLab API
- [ ] Мониторинг затрат на API (token usage)
- [ ] Multi-tenant: несколько команд на одном инстансе
- [ ] Drag-and-drop в канбане (ручное перемещение задач)
