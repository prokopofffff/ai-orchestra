# AI Orchestra — Архитектура оркестратора AI-агентов

## Context

Цель — создать систему оркестрации AI-агентов, имитирующую команду разработки. Пользователь общается с Tech Lead через Telegram и Dashboard (оба канала равноправны). Агенты-разработчики выполняют задачи автономно. Система даёт полный контроль: чёткие роли, Flow Guard для валидации межагентного взаимодействия, встроенный task tracker с kanban board.

### Ключевые принципы

- **Telegram и Dashboard равноправны** — пользователь может писать и получать ответы в обоих каналах. Единый Conversation API обеспечивает синхронизацию.
- **Агенты не мержат код** — мердж происходит только по инициативе пользователя через GitHub UI.
- **QA пишет все тесты** — unit, integration, e2e. Разработчики не пишут тестов.
- **Деплой через CI/CD** — DevOps настраивает пайплайны, деплой автоматический после мержа.
- **Scope isolation** — каждый агент ограничен своей областью кода. Frontend не может править backend и наоборот. Галлюцинации отлавливаются на этапе ревью.
- **Resume first** — при сбое агента сессия возобновляется, а не начинается с нуля.

---

## Быстрый старт

### Требования

- Docker + Docker Compose
- Node.js 20+ и pnpm
- Claude Max подписка (claude CLI залогинен)
- (Опционально) Telegram Bot Token, GitHub Token

### Запуск

```bash
git clone <repo> && cd ai-orchestra
pnpm install
pnpm setup        # интерактивный wizard
docker compose up
```

### Setup Wizard (`pnpm setup`)

Интерактивный CLI на `@clack/prompts`:

```
┌  AI Orchestra — Setup
│
◆  Claude authentication:
│  ● Claude Max subscription (claude CLI already logged in)
│  ○ Claude API key (для будущего использования)
│
◆  Telegram Bot Token (опционально, Enter чтобы пропустить):
│  123456:ABC-DEF...
│
◆  GitHub Token (опционально, Enter чтобы пропустить):
│  ghp_xxxx...
│
◆  GitHub defaults:
│  Repository owner/org: myorg
│  Default branch: main
│
◆  Create first project?
│  ● Yes → Project name: my-app
│          Repository: https://github.com/myorg/my-app (или "create new")
│  ○ No, I'll create one later
│
└  ✓ Config saved to .env
   ✓ Run `docker compose up` to start
```

### Что генерирует wizard

**`.env`** — единственный файл конфигурации:
```env
# Required
CLAUDE_AUTH=max                    # "max" | "api"
CLAUDE_API_KEY=                    # только если auth=api

# Optional
TELEGRAM_BOT_TOKEN=
GITHUB_TOKEN=
GITHUB_DEFAULT_ORG=myorg
GITHUB_DEFAULT_BRANCH=main

# Auto-generated
POSTGRES_PASSWORD=<random>
SESSION_SECRET=<random>
```

### Преднастроенные модули (не требуют конфигурации)

| Модуль | Детали |
|--------|--------|
| PostgreSQL | Docker image, auto-migrations при первом запуске |
| Task Tracker | Дефолтные состояния, типы, приоритеты |
| Flow Guard | Routes + actions + state machine захардкожены |
| Dashboard | Собран, раздаётся orchestra-core |
| Prompts агентов | `prompts/*.md` с дефолтными system prompts |
| MCP Tools | signal-tool, task-tool собраны и готовы |
| Rate Limiter | Дефолтные приоритеты по ролям |
| Notification Hub | Dashboard-only без TG токена |

### Graceful degradation

```
Без Telegram Token → Dashboard-only режим, TG-элементы скрыты
Без GitHub Token  → Агенты работают с локальным git,
                    PR/repo создаются вручную (Tech Lead даёт инструкции)
```

### Auto-migrations при старте orchestra-core

1. Ждёт PostgreSQL (retry 5 раз с backoff)
2. Запускает миграции (`src/migrations/*.sql` — идемпотентные, `IF NOT EXISTS`)
3. Если wizard создал проект — он уже в БД, иначе user создаёт через Dashboard/TG

---

## Модель проектов и workspace

### Изоляция проектов

Orchestra-core — один инстанс, но каждый проект полностью изолирован:

| Ресурс | Изоляция |
|--------|----------|
| Задачи, Epic'и | `project_id` FK |
| Conversations | per-project чат |
| Сессии агентов | привязаны к project |
| Session summaries | `docs/sessions/{project}/` |
| Git ветки | namespace: `{project}/{role}/{taskId}` |
| CLAUDE.md | per-project, генерируется Tech Lead |

### Workspace — работа агентов с репозиторием

Все агенты одного проекта работают в **одном клоне репозитория**, каждый на своей ветке:

```
~/orchestra-workspaces/{project}/
  └── repo/                          ← git clone
      ├── main                       ← основная ветка (не трогается)
      ├── feature/backend/auth-api   ← Backend Dev (git worktree)
      ├── feature/frontend/auth-ui   ← Frontend Dev (git worktree)
      ├── design/design-system       ← Designer (git worktree)
      └── ci/setup-pipeline          ← DevOps (git worktree)
```

**Agent Spawner при создании агента:**
1. Создаёт git branch от main: `feature/{role}/{taskId}`
2. Создаёт git worktree для этой ветки
3. Запускает Claude Code в директории worktree
4. После завершения — worktree удаляется, ветка остаётся (для PR)

**Преимущества git worktrees:**
- Полная изоляция файлов между агентами
- Один `.git` — экономия диска
- Claude Code нативно поддерживает worktrees
- Нет конфликтов при параллельной работе

---

## Компоненты системы

### Инфраструктура (Docker Compose)

```
docker-compose.yml
├── postgres         — БД (сессии, задачи, сигналы, flow audit, conversations)
└── orchestra-core   — единый сервис: API, session manager, task tracker,
                       conversation api, notification hub, flow guard,
                       webhooks, dashboard (порт 3000)
```

### orchestra-core (единый сервис)

- **Session Manager** — управление сессиями Claude Code (создание, resume, завершение)
- **Signal API + Flow Guard** — межагентная коммуникация с жёсткой валидацией маршрутов и действий
- **Task API** — встроенный task tracker (проекты, задачи, комментарии, зависимости)
- **Conversation API** — единый чат user ↔ Tech Lead, синхронизированный между Telegram и Dashboard
- **Notification Hub** — маршрутизация уведомлений во все каналы (Telegram + Dashboard)
- **Agent Spawner** — создание агентов с git branch, bootstrap контекст, per-role MCP config
- **Rate Limiter** — очередь задач с приоритетами при rate limit подписки Claude
- **Webhooks** — Telegram Bot API и GitHub/GitLab webhooks напрямую
- **Dashboard** — React SPA (kanban board, agent graph, signal feed, chat)

### Агенты

| Роль | Тип сессии | Модель (default) | Когда запускается |
|------|-----------|-----------------|-------------------|
| Tech Lead | Долгоживущая (A+C) | opus | Telegram сообщение, сигнал от Dev/QA/Designer, PR webhook, cron |
| Designer | Per-task | sonnet | Сигнал create_design / create_design_system от Tech Lead |
| Frontend Dev | Per-task | sonnet | Назначение задачи от Tech Lead (после design_ready) |
| Backend Dev | Per-task | sonnet | Назначение задачи от Tech Lead (параллельно с Designer) |
| QA/Tester | Per-task | sonnet | PR создан разработчиком |
| DevOps | Per-task | sonnet | Задача на CI/CD или деплоймент |

### Конфигурация моделей

Модель каждого агента настраивается на двух уровнях:

**Глобально** (`.env` / Setup Wizard):
```env
MODEL_TECH_LEAD=opus
MODEL_DESIGNER=sonnet
MODEL_FRONTEND=sonnet
MODEL_BACKEND=sonnet
MODEL_QA=sonnet
MODEL_DEVOPS=sonnet
```

**Per-project** (через Dashboard / Conversation API):
- Tech Lead может предложить сменить модель для конкретной задачи
- User может переопределить модель per-project через Dashboard settings
- Per-project настройки хранятся в `projects.settings JSONB`

**Доступные модели:** `opus`, `sonnet`, `haiku` — передаётся как `claude --model {model}`

Agent Spawner использует приоритет: per-project → глобальный `.env` → default из таблицы выше

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

**Ревью PR:**
- Tech Lead использует skill `requesting-code-review` → спавнит subagent-reviewer без bias
- Reviewer получает полный контекст задачи: description, acceptance criteria, linked design, discussion
- Проверяет scope isolation: агент не вышел за пределы разрешённых путей
- Результат: approve / changes_requested с конкретными замечаниями

### Designer — workflow

**Артефакты:**
- `.pen` файлы — живут в репо проекта, но добавлены в `.gitignore` (не попадают в GitHub)
- `STYLE.md` — design system, живёт в репо, коммитится в GitHub
- Frontend Dev читает `.pen` через Pencil MCP (batch_get, get_screenshot) и `STYLE.md`

**Redesign:**
- Если дизайн меняется после начала разработки — создаётся новая задача с повышенным приоритетом
- Tech Lead оценивает impact и может заблокировать зависимые задачи
- Frontend Dev получает сигнал о redesign и новую задачу

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

### Scope Isolation — ограничение области кода

Каждый агент имеет доступ только к своей области кода. Реализуется через CLAUDE.md per-project + per-role инструкции в system prompt.

| Роль | Разрешённые пути | Запрещённые пути |
|------|-----------------|------------------|
| Frontend Dev | `src/frontend/`, `src/shared/types/`, `public/` | `src/backend/`, `src/api/`, `database/` |
| Backend Dev | `src/backend/`, `src/api/`, `database/`, `src/shared/types/` | `src/frontend/`, `public/`, `*.css` |
| Designer | `design/`, `*.pen`, `STYLE.md` | `src/` |
| QA | `tests/`, `e2e/`, `src/` (read-only для контекста) | Не может менять `src/` |
| DevOps | `.github/`, `docker-compose.yml`, `Dockerfile`, `ci/` | `src/` (кроме конфигов) |

**Реализация:**
- Tech Lead при создании проекта описывает структуру папок в CLAUDE.md
- Agent Spawner добавляет scope-правила в system prompt агента
- Нарушения scope отлавливаются на этапе PR review (Tech Lead subagent)
- Агент может удалять ненужные файлы в пределах своего scope

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

### Зависимости и блокировки

Задачи могут блокировать друг друга. Поле `blocked_by` содержит массив task ID.

```
tasks.blocked_by UUID[]  — задачи, которые должны быть завершены перед началом
tasks.blocking UUID[]    — задачи, которые ждут завершения текущей (computed)
```

**Правила:**
- Tech Lead устанавливает зависимости при создании задач
- Agent Spawner не запускает агента, пока все `blocked_by` задачи не в состоянии `merged` или `closed`
- Когда задача завершается, проверяются все задачи где она в `blocked_by` — если все зависимости сняты, Tech Lead получает сигнал и может назначить агента
- Dashboard показывает блокировки визуально на kanban (иконка + tooltip "blocked by: Task X")
- User уведомляется если задача заблокирована дольше порога (настраиваемый)

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

**Запуск агента:**
1. Проверяет `blocked_by` — не запускает если есть незавершённые зависимости
2. Создаёт git branch от main: `feature/{role}/{taskId}`
3. Создаёт git worktree в `~/orchestra-workspaces/{project}/`
4. Генерирует per-role MCP config (Pencil MCP для designer/frontend)
5. Добавляет scope-правила в system prompt (какие папки разрешены)
6. Bootstrap контекст из session summaries + задач + pending сигналов
7. Запускает Claude Code (`claude --dangerously-skip-permissions`) в worktree директории
8. После завершения: worktree cleanup, ветка остаётся (для PR)
- Retry с exponential backoff (до 2 попыток)
- Уведомление пользователя при failure

**Rebase перед PR:**
- Агент обязан сделать `git rebase main` перед созданием PR (указано в system prompt)
- Если rebase clean → агент создаёт PR через `gh pr create`
- Если rebase conflict → агент шлёт сигнал `escalate` Tech Lead с описанием конфликта
- Tech Lead решает конфликт (может заспавнить subagent) и завершает rebase
- PR description пишет агент: summary изменений, linked task, acceptance criteria

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

**Обнаружение rate limit:**
- Agent Spawner парсит stderr Claude CLI на предмет rate limit ошибки
- При обнаружении: извлекает время сброса лимита из ответа
- Создаёт cron job на время сброса → автоматический перезапуск очереди
- Все ожидающие задачи остаются в очереди с приоритетами

**Usage tracking:**
- Периодический опрос usage (через Claude CLI / API)
- Dashboard показывает текущий usage: использовано / лимит
- Уведомление user при приближении к лимиту (80%, 95%)

### Heartbeat — мониторинг здоровья агентов

Orchestra-core проверяет состояние каждой активной сессии:

```
Каждые 30 сек:
  Для каждой running сессии:
    1. Проверить процесс Claude Code жив (pid check)
    2. Проверить последний output timestamp (stale detection)
    3. Если процесс мёртв → пометить сессию как crashed
    4. Если stale > 10 мин → пометить как hung
```

**Recovery при crash/hang:**
- Per-task агент (Dev/QA/Designer): `claude --resume ${session_id}` в том же worktree
- Tech Lead: `claude --resume ${session_id}`, если сессия невосстановима — новая сессия с полным bootstrap (last summary + задачи + pending сигналы)
- Retry до 2 раз, затем escalate к user
- Dashboard показывает статус: running / recovering / failed

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
| `task_blocked` | System → Tech Lead | Задача заблокирована зависимостью |
| `task_unblocked` | System → Tech Lead | Все зависимости сняты, задача готова к назначению |
| `deploy` | Tech Lead → DevOps | Задеплоить проект |
| `setup_cicd` | Tech Lead → DevOps | Настроить CI/CD |

---

## Conversation API — единый канал user ↔ Tech Lead

Telegram и Dashboard — два равноправных фронтенда к одному чату. Все сообщения хранятся в PostgreSQL.

### Модель данных

```sql
conversations (
  id UUID PRIMARY KEY,
  project_id UUID REFERENCES projects(id),
  created_at TIMESTAMPTZ
);

messages (
  id UUID PRIMARY KEY,
  conversation_id UUID REFERENCES conversations(id),
  from_role TEXT NOT NULL,        -- 'user' | 'tech-lead' | 'system'
  source TEXT NOT NULL,           -- 'telegram' | 'dashboard'
  text TEXT NOT NULL,
  metadata JSONB,                 -- task_id, signal_id, etc.
  created_at TIMESTAMPTZ
);
```

### Потоки данных

```
User (Telegram) ──┐
                   ├──→ Conversation API ──→ Dispatch Tech Lead
User (Dashboard) ──┘          │
                              ├──→ Telegram Bot (push)
Tech Lead ответ ──→ Conversation API
                              └──→ Dashboard (polling / SSE)
```

### API

- `GET /api/conversations/:projectId/messages` — история чата (pagination)
- `POST /api/conversations/:projectId/messages` — отправить сообщение (от user через Dashboard)
- Telegram webhook автоматически пишет в conversations и диспатчит Tech Lead
- Tech Lead отвечает через signal `notify_user` → пишется в conversations → пушится в оба канала

### Системные уведомления

Важные события автоматически попадают в чат как `from: "system"`:
- Задача сменила статус (in_development → pr_created)
- PR одобрен / запрошены изменения
- Агент заблокирован и нужен input
- Escalation от любого агента

---

## Notification Hub

Централизованная маршрутизация уведомлений. Любое событие, которое должен увидеть user, проходит через Notification Hub.

### Каналы

| Канал | Механизм | Что отправляет |
|-------|----------|----------------|
| Telegram | Bot API `sendMessage` | Текст + ссылка на Dashboard |
| Dashboard | Polling / SSE | Обновление чата + toast-уведомления |

### Типы уведомлений

| Событие | Приоритет | Содержание |
|---------|-----------|------------|
| Tech Lead ответ | High | Текст ответа |
| Escalation | High | Вопрос агента + контекст |
| PR ready for merge | High | Ссылка на PR |
| Task state change | Normal | "Task X → in_development" |
| Agent spawned/finished | Low | "Designer started task X" |

---

## Webhooks (встроенные)

### Telegram
```
POST /api/telegram/webhook
← Telegram Bot API update
→ Определить проект → Dispatch Tech Lead с текстом сообщения
```

**Multi-project в одном боте:**
- Бот хранит `active_project` per user (в PostgreSQL)
- Команды: `/projects` — список проектов, `/switch <name>` — переключить активный
- При создании нового проекта — автоматически становится активным
- Если проект один — выбор не нужен
- Все сообщения без команды идут в активный проект

### GitHub/GitLab
```
POST /api/git/webhook
← PR opened → Dispatch QA
← PR review → Notify Tech Lead
← Push → Notify user via Telegram
```

---

## Полный жизненный цикл фичи

### Пошагово

```
 1. User → TG/Dashboard: "Хочу приложение для заметок с авторизацией"
 2. Orchestra: создаёт project (+ repo через GitHub API, если нужно)
 3. Tech Lead (product) → Conversation:
    "Какой тип авторизации? Email/Google/GitHub? Какие фичи MVP?"
    → видно в TG + Dashboard
 4. User → TG/Dashboard: "Email авторизация, CRUD заметок, markdown"
 5. Tech Lead (technical):
    - Создаёт Epic "Notes App MVP"
    - Создаёт задачи с зависимостями:
      • Design System (Designer)
      • Auth API (Backend) — нет зависимостей, стартует параллельно
      • Auth UI (Frontend) — blocked_by: Design System
      • Notes CRUD API (Backend) — нет зависимостей
      • Notes UI (Frontend) — blocked_by: Design System, Notes CRUD API
      • CI/CD Setup (DevOps)
    → Conversation (system): "Создал 6 задач, начинаю работу"
    → Dashboard: kanban обновился
 6. Параллельный запуск:
    Tech Lead → Designer: create_design_system
    Tech Lead → Backend: assign_dev (Auth API)
    Tech Lead → Backend: assign_dev (Notes CRUD API)
    Tech Lead → DevOps: setup_cicd
 7. Designer → design_ready → разблокирует Frontend задачи
    Tech Lead → Frontend: assign_dev (Auth UI)
 8. Notes CRUD API done → разблокирует Notes UI
    Tech Lead → Frontend: assign_dev (Notes UI)
 9. Каждый PR → QA пишет все тесты (unit + integration + e2e)
    QA → tests_passed
10. Tech Lead ревьюит PR (через subagent-reviewer)
    → approve / changes_requested
11. → Conversation: "PR #12 одобрен, можешь мержить: <link>"
    → TG + Dashboard: user видит
12. User мержит через GitHub UI
13. CI/CD (настроенный DevOps) деплоит автоматически
```

### Диаграмма

```
              User (Telegram)  User (Dashboard)
                    │                │
                    └───────┬────────┘
                            │
                    Conversation API
                            │
                  ┌─────────▼──────────┐
                  │     Tech Lead      │
                  │  product+technical │
                  │  • Уточняет детали │
                  │  • Epic + задачи   │
                  │  • Зависимости     │
                  └──┬──────┬──────┬───┘
                     │      │      │
         create_design │  assign_dev  setup_cicd
                     │      │      │
            ┌────────▼─┐ ┌──▼───┐ ┌▼───────┐
            │ Designer │ │ Back │ │ DevOps  │  (параллельно)
            │ • system │ │ • API│ │ • CI/CD │
            │ • макеты │ │ • PR │ └────────┘
            └────┬─────┘ └──┬───┘
                 │          │
    design_ready │     pr_created
        (unblock)│          │
            ┌────▼─────┐ ┌──▼───────┐
            │ Frontend  │ │ QA (back)│
            │ • код     │ │ • тесты  │
            │ • PR      │ └──┬───────┘
            └────┬─────┘    │
                 │     tests_passed
            pr_created      │
                 │          │
            ┌────▼─────┐    │
            │ QA(front)│    │
            │ • тесты  │    │
            └────┬─────┘    │
                 │          │
            tests_passed    │
                 │          │
            ┌────▼──────────▼─────────┐
            │       Tech Lead         │
            │  • Ревью (subagent)     │
            │  • Approve → Notify     │
            └────────────┬────────────┘
                         │
                Conversation API
                    │         │
              Telegram    Dashboard
                    │         │
                User мержит в GitHub UI
                         │
                   CI/CD деплоит
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
│       ├── heartbeat.ts            # Мониторинг здоровья агентов (pid, stale check)
│       ├── task-api.ts             # Встроенный task tracker (CRUD)
│       ├── rate-limiter.ts         # Очередь с приоритетами (persistent)
│       ├── session-context.ts      # Bootstrap контекст из summaries + задач
│       ├── mcp-config-generator.ts # Per-role MCP config
│       ├── conversation-api.ts     # Conversation CRUD, message routing
│       ├── notification-hub.ts    # Маршрутизация уведомлений (TG + Dashboard)
│       ├── webhooks.ts             # Telegram + GitHub/GitLab webhooks
│       ├── notify.ts               # Telegram Bot API notifications
│       ├── db-utils.ts             # parseRow/parseRows (snake→camel + Zod)
│       ├── setup-wizard.ts         # CLI интерактивная настройка (@clack/prompts)
│       └── migrations/
│           ├── 001-projects-tasks.sql
│           ├── 002-sessions-signals.sql
│           ├── 003-conversations.sql
│           └── 004-flow-audit.sql
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
│           ├── Chat.tsx            # Чат user ↔ Tech Lead
│           └── CreateForms.tsx     # Формы создания проекта/задачи
├── prompts/
│   ├── tech-lead.md
│   ├── designer.md
│   ├── dev-frontend.md
│   ├── dev-backend.md
│   ├── qa.md
│   └── devops.md
└── templates/
    ├── CLAUDE.md.template          # Шаблон per-project, Tech Lead кастомизирует
    └── .gitignore.template         # Включает *.pen, orchestra-sessions/
```

---

## Память агентов

### Кто пишет summary

Каждый агент сам записывает summary перед завершением сессии (инструкция в system prompt). Orchestra-core сохраняет файл в workspace проекта.

### При завершении сессии

```
~/orchestra-workspaces/{project}/sessions/{role}-{date}-{n}.md
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

### Tech Lead — переполнение контекста

Tech Lead — долгоживущая сессия. Когда context window заполняется:

1. Claude Code автоматически компрессирует контекст (встроенная функция)
2. Если сессия стала неадекватной / потеряла контекст:
   - Heartbeat детектит проблему (stale output / ошибки)
   - Orchestra записывает текущий summary (через signal к Tech Lead: "запиши summary и заверши сессию")
   - Создаёт новую сессию Tech Lead с полным bootstrap
3. CLAUDE.md per-project обновляет только Tech Lead — это его ответственность

### При bootstrap новой сессии

orchestra-core собирает:
1. Последний session summary для роли
2. Текущие задачи из task tracker
3. Непрочитанные сигналы (атомарно помечаются прочитанными)
4. Design system (STYLE.md) для designer/frontend
5. CLAUDE.md проекта
6. Scope-правила для роли

---

## Верификация / Как тестировать

1. `pnpm setup` — wizard создаёт `.env`, опционально первый проект
2. `docker compose up -d` — postgres + orchestra-core поднимаются, миграции пройдены
3. Dashboard на http://localhost:3000 — проект виден, kanban пуст
4. Dashboard Chat или Telegram → сообщение → Tech Lead dispatched
5. Flow Guard — отклоняет невалидные сигналы с 403
6. Kanban — задачи по колонкам, блокировки визуально отображены
7. Signal Feed — все сигналы (allowed/rejected)
8. Без TG токена — Dashboard работает полностью, TG-элементы скрыты

---

## План имплементации

### Phase 1 — Фундамент

Инфраструктура и API, которые можно тестировать через curl/Postman без агентов и UI.

```
1.1  Docker Compose (postgres + orchestra-core)
1.2  PostgreSQL migrations (projects, tasks, sessions, signals, conversations, flow_audit)
1.3  Config (zod-схема .env, загрузка, валидация, defaults моделей)
1.4  Setup Wizard (@clack/prompts → генерация .env, опционально первый проект)
1.5  Task API (CRUD проектов, задач, комментариев, blocked_by зависимости)
1.6  Flow Guard (allowed routes, allowed actions, state machine, audit log)
1.7  Signal API (валидация через Flow Guard, логирование, без dispatch)
```

**Результат:** `pnpm setup && docker compose up` — API работает, задачи и сигналы через curl.

---

### Phase 2 — Агенты (ядро)

Возможность спавнить агентов и запускать их на задачи. Первый тестовый агент — Backend Dev.

```
2.1  Session Manager (create, resume, terminate, хранение в PostgreSQL)
2.2  Agent Spawner (git branch, worktree, scope rules, bootstrap контекст, --model flag)
2.3  MCP Tools: signal-tool (signal_agent, notify_user)
2.4  MCP Tools: task-tool (task_create, task_update, task_get, task_list, task_add_comment)
2.5  MCP Config Generator (per-role: какие MCP tools доступны)
2.6  System prompts для всех ролей (prompts/*.md)
2.7  CLAUDE.md template + .gitignore template (*.pen, sessions/)
2.8  Тест: Backend Dev спавнится → работает в worktree → создаёт PR
```

**Результат:** можно вручную спавнить агента через API, он работает в worktree и создаёт PR.

---

### Phase 3 — Оркестрация

Агенты взаимодействуют друг с другом через Tech Lead. Полный цикл задачи.

```
3.1  Dispatch logic (сигнал → определить получателя → спавн/resume агента)
3.2  Tech Lead prompt (product + technical режимы, PR review через subagent)
3.3  Heartbeat (pid check, stale detection, auto-recovery, resume first)
3.4  Rate Limiter (парсинг ошибок CLI, cron на сброс, очередь с приоритетами)
3.5  Rebase flow (агент ребейзит перед PR, escalate при конфликтах)
3.6  Task dependency engine (blocked_by проверка, auto-unblock, сигналы task_blocked/unblocked)
3.7  Тест: Tech Lead получает задачу → спавнит Backend Dev → PR → QA → review → notify user
```

**Результат:** полный цикл от сигнала до PR ready for merge, recovery при сбоях.

---

### Phase 4 — Коммуникация

User может общаться с системой через Telegram и Dashboard Chat.

```
4.1  Conversation API (messages CRUD, per-project)
4.2  Notification Hub (маршрутизация событий → TG + Dashboard)
4.3  Telegram Bot (webhook, dispatch Tech Lead, multi-project: /projects, /switch)
4.4  Двусторонняя синхронизация (TG → Conversation ← Dashboard)
4.5  Системные уведомления (state changes, escalations, PR ready)
4.6  Тест: сообщение в TG → Tech Lead отвечает → ответ виден в TG
```

**Результат:** полноценное общение user ↔ Tech Lead через оба канала.

---

### Phase 5 — Dashboard

Полный веб-интерфейс для управления и мониторинга.

```
5.1  Dashboard shell (App.tsx, api.ts, types.ts, routing, project selector)
5.2  Kanban Board (колонки по фазам, blocked визуализация, drag карточки)
5.3  Task Detail Modal (edit state/priority/assignee, description, comments, blocked_by)
5.4  Create Forms (проект, задача)
5.5  Chat component (чат с Tech Lead, системные сообщения, real-time)
5.6  Signal Feed (audit log лента, allowed/rejected, фильтры)
5.7  Agent Graph (SVG схема ролей, live статусы, связи)
5.8  Agent Cards (активные сессии, роль, задача, статус, модель)
5.9  Task Queue (rate-limited задачи в очереди, приоритеты)
5.10 Usage Widget (текущий usage Claude, процент от лимита)
5.11 Project Settings (модели per-project, repo URL)
5.12 Тест: полный цикл виден на Dashboard — от создания задачи до PR
```

**Результат:** полный Dashboard с kanban, чатом, мониторингом агентов и usage.

---

### Phase 6 — Polish & Integration

Edge cases, Designer workflow, end-to-end тест.

```
6.1  Designer workflow (Pencil MCP, .pen файлы, STYLE.md, design_ready → unblock frontend)
6.2  Scope isolation проверка на PR review (subagent проверяет пути)
6.3  Tech Lead context overflow (graceful завершение, summary, respawn)
6.4  Usage tracking (периодический опрос, уведомления при 80%/95%)
6.5  Error handling (все edge cases: агент завис, БД недоступна, TG API down)
6.6  End-to-end тест: TG сообщение → Tech Lead → Designer → Backend → Frontend → QA → review → notify
6.7  Документация: README с примерами, troubleshooting
```

**Результат:** production-ready система, протестированная end-to-end.

---

## Планы на будущее

- [ ] Telegram webhook через публичный URL (ngrok / Cloudflare Tunnel)
- [ ] End-to-end test: полный цикл фичи от Telegram до merge
- [ ] Git PR creation через GitHub/GitLab API
- [ ] Мониторинг затрат на API (token usage)
- [ ] Multi-tenant: несколько команд на одном инстансе
- [ ] Drag-and-drop в канбане (ручное перемещение задач)
