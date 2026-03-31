# AI Orchestra — Архитектура оркестратора AI-агентов

## Context

Цель — создать систему оркестрации AI-агентов, имитирующую команду разработки. Пользователь общается с Tech Lead через Telegram. Агенты-разработчики выполняют задачи автономно. В отличие от Paperclip, система даёт больше контроля: чёткие роли, event-driven архитектура, интеграция с task tracker и git.

---

## Компоненты системы

### Инфраструктура (Docker Compose)

```
docker-compose.yml
├── n8n              — центральный оркестратор (порт 5678)
├── openproject      — task tracker (порт 8080)  
├── openclaw         — Telegram-мост (Node.js)
├── postgres         — БД для n8n + OpenProject
└── orchestra-core   — setup wizard + signal API + session manager (Node.js)
```

`orchestra-core` — наш сервис, который:
- Предоставляет setup wizard (CLI или web)
- Управляет сессиями Claude Code (создание, resume, завершение)
- Предоставляет signal API для межагентной коммуникации
- Отслеживает лимиты подписки и очередь задач

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

**Режим "product" (бывший PM):**
- Уточняет фичу с пользователем через Telegram
- Создаёт Epic и задачи в OpenProject
- Назначает разработчиков
- Отслеживает прогресс, уведомляет пользователя

**Режим "technical" (бывший CTO):**
- Пишет техническое описание задач, acceptance criteria
- Определяет параллельность задач для разработчиков
- Проектирует архитектуру, описывает стек и конвенции
- Настраивает CLAUDE.md проекта

**Ревью PR** — для объективности Tech Lead использует skill `requesting-code-review`
из Superpowers, который спавнит отдельный subagent-reviewer без bias.

---

## Setup Wizard (первоначальная настройка)

CLI/интерактивный wizard при первом запуске `docker compose up`:

```
1. Базовая настройка
   → Имя организации/команды
   → GitHub или GitLab?
   → Git credentials (token с правами на repo, org, PR)
   → Создать организацию? Или использовать существующую?

2. Claude Code
   → Проверка что `claude` CLI доступен
   → Проверка подписки
   → Установка superpowers плагина

3. Telegram
   → Telegram bot token (для OpenClaw)
   → Pairing code для привязки пользователя

4. Первый проект (опционально)
   → Название проекта
   → Описание
   → Tech Lead начинает диалог для уточнения стека и деталей
```

Результат: конфиг `orchestra.config.yaml` + проект в OpenProject + репо(s) в GitHub/GitLab.

---

## Управление сессиями

### Session Manager (часть orchestra-core)

```typescript
interface AgentSession {
  id: string;
  role: "tech-lead" | "frontend" | "backend" | "qa" | "devops";
  projectId: string;
  claudeSessionId: string;    // для --resume
  createdAt: Date;
  lastActiveAt: Date;
  status: "running" | "sleeping" | "terminated";
  taskId?: string;             // для per-task агентов
}
```

**Логика resume vs new (модель A+C):**
```
function shouldResume(session):
  if session.status == "terminated": return false
  if age(session) > 8 hours: return false          // A: таймаут
  if session.contextChanged(project): return false  // C: смена фазы
  return true
```

**Запуск агента:**
```bash
# Новая сессия
claude --dangerously-skip-permissions \
  --system-prompt "$(cat prompts/${role}.md)" \
  --allowedTools "Edit,Write,Read,Bash,Glob,Grep" \
  --mcp-config mcp-tools.json \
  -p "Ты ${role}. Прочитай CLAUDE.md и docs/. Задача: ${task_description}"

# Resume сессии  
claude --resume ${session_id} \
  -p "Новое событие: ${event_description}"
```

**MCP tools доступные агентам:**
- `signal_agent(to, action, context)` — послать сигнал другому агенту
- `openproject_*` — CRUD задач, комментариев
- `notify_user(message)` — уведомить пользователя в Telegram

### Обработка лимитов подписки

```
При запуске агента:
  if rate_limit_hit:
    → Сохранить задачу в очередь (n8n queue)
    → Создать cron job: проверять каждые 5 минут
    → Когда лимит восстановлен → запустить из очереди по приоритету
    → Приоритет: Tech Lead > Dev/QA/DevOps
```

---

## Межагентная коммуникация (Signal System)

### Signal API (orchestra-core)

```
POST /api/signal
{
  "from": "dev-frontend",
  "to": "tech-lead",
  "action": "question",
  "context": {
    "project_id": "my-app",
    "task_id": 101,
    "message": "Какой роутер использовать — React Router или TanStack Router?"
  }
}
```

### n8n Workflow: Signal Router

```
Webhook /api/signal
  → Switch по "to":
    → "tech-lead": resume/create Tech Lead session
    → "dev-*": resume/create Dev session
    → "qa": resume/create QA session
    → "devops": resume/create DevOps session
    → "user": отправить в Telegram через OpenClaw
  → Логирование в OpenProject (комментарий к задаче)
  → Дублирование в Telegram (если пользователь подписан на уведомления)
```

### Типы сигналов

| action | from → to | Описание |
|--------|-----------|----------|
| `create_design_system` | Tech Lead → Designer | Создать design system проекта |
| `create_design` | Tech Lead → Designer | Создать дизайн экрана для задачи |
| `design_system_ready` | Designer → Tech Lead | Design system готов |
| `design_ready` | Designer → Tech Lead | Дизайн экрана готов, ссылка в задаче |
| `assign_dev` | Tech Lead → n8n | Запустить dev-агента на задачу |
| `question` | Dev/Designer → Tech Lead | Вопрос по архитектуре/реализации/дизайну |
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

## Полный жизненный цикл фичи

```
                       Пользователь (Telegram)
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

Каждый агент запускается с установленным плагином Superpowers, но активные skills ограничены ролью через system prompt (инструкция "используй ТОЛЬКО эти skills").

### Матрица skills × роли

| Skill | Tech Lead | Designer | Frontend Dev | Backend Dev | QA | DevOps |
|-------|:---------:|:--------:|:------------:|:-----------:|:--:|:------:|
| **using-superpowers** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **brainstorming** | ✅ | ✅ | — | — | — | — |
| **writing-plans** | ✅ | — | — | — | — | — |
| **subagent-driven-development** | ✅ | — | ✅ | ✅ | — | — |
| **executing-plans** | — | — | ✅ | ✅ | — | ✅ |
| **dispatching-parallel-agents** | ✅ | — | — | — | — | — |
| **test-driven-development** | — | — | ✅ | ✅ | ✅ | — |
| **systematic-debugging** | — | — | ✅ | ✅ | ✅ | ✅ |
| **verification-before-completion** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **requesting-code-review** | ✅ | — | ✅ | ✅ | — | — |
| **receiving-code-review** | — | — | ✅ | ✅ | — | — |
| **finishing-a-development-branch** | — | — | ✅ | ✅ | ✅ | ✅ |
| **using-git-worktrees** | — | — | ✅ | ✅ | ✅ | ✅ |
| **writing-skills** | ✅ | — | — | — | — | — |
| **Pencil MCP tools** | — | ✅ (all) | ✅ (read-only) | — | — | — |

### Обоснование по ролям

**Tech Lead (8 skills):**
- `brainstorming` — уточнение фичи с пользователем, формирование спеки
- `writing-plans` — декомпозиция Epic на задачи с техническим описанием
- `subagent-driven-development` — делегирование подзадач субагентам при ревью
- `dispatching-parallel-agents` — определяет параллельность задач для dev'ов (Designer || Backend, Frontend после Designer)
- `verification-before-completion` — верификация при code review
- `requesting-code-review` — спавнит subagent-reviewer для объективного ревью PR
- `writing-skills` — может создавать новые skills для команды
- Tech Lead НЕ кодит напрямую → нет TDD, git worktrees, executing-plans, receiving-code-review

**Designer (3 skills + Pencil MCP):**
- `brainstorming` — обсуждение дизайна с Tech Lead при необходимости
- `verification-before-completion` — проверка результата перед передачей
- Per-task, но обеспечивает единый стиль через design system:
  - `designs/design-system.pen` — единый design system (цвета, компоненты)
  - `designs/STYLE.md` — описание стиля в markdown
  - Изучает существующие экраны через `batch_get()` перед созданием новых
- Pencil MCP tools — основной инструмент (get_guidelines, get_style_guide, batch_design, etc.)
- .pen файлы хранятся в `designs/` директории проекта (gitignored)

**Frontend Dev (9 skills + Pencil MCP read-only):**
- Полный цикл разработки: plan → execute → TDD → debug → review → finish
- `subagent-driven-development` — для сложных задач с подзадачами
- `using-git-worktrees` — изоляция работы в ветках
- `requesting/receiving-code-review` — взаимодействие с Tech Lead по PR

**QA (6 skills):**
- `test-driven-development` — основной skill, написание тестов
- `systematic-debugging` — исследование багов при написании тестов
- `verification-before-completion` — проверка покрытия перед сигналом "тесты готовы"
- `using-git-worktrees` — тесты пишутся в ветке PR
- `finishing-a-development-branch` — коммит тестов в ветку PR
- НЕ делает code review и НЕ brainstorm'ит

**DevOps (5 skills):**
- `executing-plans` — выполнение плана по CI/CD или деплою
- `systematic-debugging` — диагностика проблем инфраструктуры
- `verification-before-completion` — проверка что pipeline/деплой работает
- `using-git-worktrees` + `finishing-a-development-branch` — конфиги CI/CD в ветке

### Конфигурация skills в system prompt (пример для Dev)

В system prompt каждого агента добавляется секция:
```markdown
## Superpowers Skills
Ты ДОЛЖЕН использовать следующие skills из плагина Superpowers:
- using-superpowers (всегда активен)
- executing-plans (для выполнения задач по плану)
- subagent-driven-development (для сложных задач)
- test-driven-development (ОБЯЗАТЕЛЬНО: тесты перед кодом)
- systematic-debugging (при любых ошибках)
- verification-before-completion (перед созданием PR)
- requesting-code-review (перед отправкой PR на ревью)
- receiving-code-review (при получении замечаний от Tech Lead)
- finishing-a-development-branch (после завершения работы)
- using-git-worktrees (для изоляции работы)

НЕ используй: brainstorming, writing-plans, dispatching-parallel-agents, writing-skills
```

---

## Промпты агентов

### Структура файлов

```
ai-orchestra/
├── docker-compose.yml
├── orchestra-core/
│   ├── package.json
│   ├── src/
│   │   ├── session-manager.ts    # управление сессиями Claude Code
│   │   ├── signal-api.ts         # REST API для сигналов
│   │   ├── setup-wizard.ts       # первоначальная настройка
│   │   ├── rate-limiter.ts       # очередь при лимитах
│   │   └── config.ts
│   └── Dockerfile
├── prompts/
│   ├── tech-lead.md              # system prompt для Tech Lead
│   ├── designer.md               # system prompt для Designer (Pencil MCP)
│   ├── dev-frontend.md
│   ├── dev-backend.md
│   ├── qa.md
│   └── devops.md
├── mcp-tools/
│   ├── signal-tool/              # MCP server: signal_agent()
│   ├── openproject-tool/         # MCP server: CRUD задач
│   └── mcp-config.json
├── n8n/
│   ├── workflows/
│   │   ├── signal-router.json    # роутинг сигналов
│   │   ├── github-webhooks.json  # обработка PR events
│   │   ├── session-manager.json  # управление жизненным циклом
│   │   └── rate-limit-queue.json # очередь при лимитах
│   └── credentials/
├── openclaw/
│   └── config.yaml               # настройка Telegram-моста
├── docs/
│   └── setup.md
└── orchestra.config.yaml          # основной конфиг
```

### Ключевые элементы system prompt (Tech Lead)

```markdown
# Роль: Tech Lead

Ты Tech Lead в команде разработки. Ты совмещаешь роли PM и CTO:
управляешь задачами, проектируешь архитектуру, ревьюишь код.

## Superpowers Skills
Ты ДОЛЖЕН использовать следующие skills из плагина Superpowers:
- using-superpowers (всегда активен)
- brainstorming (для уточнения фичи и формирования спеки)
- writing-plans (для декомпозиции Epic на задачи с тех. описанием)
- subagent-driven-development (для делегирования подзадач)
- dispatching-parallel-agents (для параллельного запуска задач)
- verification-before-completion (для верификации при ревью)
- requesting-code-review (для объективного ревью PR через subagent)
- writing-skills (для создания новых skills для команды)

НЕ используй: executing-plans, test-driven-development, systematic-debugging,
receiving-code-review, finishing-a-development-branch, using-git-worktrees

## Твои инструменты
- signal_agent(to, action, context) — связаться с другим агентом
- openproject_create_task(...) — создать задачу
- openproject_update_task(...) — обновить задачу
- notify_user(message) — написать пользователю в Telegram

## Два режима работы

### Режим "product" (триггер: сообщение от пользователя, task_done, escalate)
- Уточняй детали у пользователя, прежде чем создавать задачи
- Создавай Epic и задачи в OpenProject
- Назначай разработчиков после написания тех. описания
- Отслеживай прогресс, уведомляй пользователя

### Режим "technical" (триггер: новые задачи, PR review, вопрос от Dev)
- Пиши техническое описание и acceptance criteria для задач
- Определяй зависимости и параллельность задач
- Проектируй архитектуру, обновляй CLAUDE.md проекта
- Ревьюй PR через requesting-code-review (subagent-reviewer)
- Отвечай на технические вопросы разработчиков

## Правила
- ВСЕГДА уточняй детали у пользователя, прежде чем создавать задачи
- Задачи ДОЛЖНЫ иметь тех. описание и acceptance criteria ДО назначения dev'ов
- Для ревью PR ВСЕГДА используй requesting-code-review (объективность)
- Перед завершением сессии запиши summary в docs/sessions/
- При эскалации пользователю — чётко формулируй вопрос и варианты

## Workflow
1. Получить запрос (от пользователя или сигнал)
2. Определить режим (product / technical)
3. [product] Уточнить детали → Создать задачи → Написать тех. описание → Назначить dev'ов
4. [technical] Ответить на вопрос / Сделать ревью / Обновить архитектуру
5. Обновить статусы в OpenProject
6. Уведомить пользователя о результате
```

---

## Память агентов

### При завершении сессии (Tech Lead)

Агент записывает:
```
docs/sessions/tech-lead-{date}-{n}.md
---
role: tech-lead
project: my-app
date: 2026-03-31
session_id: abc123
---
## Summary
- Создан Epic "Авторизация" с 3 задачами
- Архитектура: JWT + refresh tokens
- Назначены: frontend #101, backend #102
- Ожидается: PR от обоих разработчиков

## Архитектурные решения
- JWT с refresh tokens, хранение в httpOnly cookies
- Пользователь хочет OAuth через Google

## Открытые вопросы
- Нужна ли 2FA? (спросить пользователя позже)
```

### При bootstrap новой сессии

n8n собирает контекст:
1. Последний session summary
2. Текущие задачи из OpenProject (через API)
3. Непрочитанные сигналы
4. Передаёт как часть промпта при создании сессии

### CLAUDE.md в репозитории проекта

Создаётся Tech Lead при настройке проекта:
```markdown
# Project: My App
## Stack: React, Node.js, PostgreSQL
## Conventions: ...
## Architecture decisions: см. docs/decisions/
```

---

## n8n Workflows

### 1. Signal Router (главный)
```
Trigger: Webhook POST /api/signal
→ Parse body (from, to, action, context)
→ Log to OpenProject (комментарий к задаче)
→ Switch by "to":
  → "tech-lead" → Session Manager: resume or create
  → "dev-*" → Session Manager: resume or create
  → "qa" → Session Manager: resume or create
  → "devops" → Session Manager: resume or create
  → "user" → OpenClaw: send Telegram message
→ Mirror to Telegram (уведомление)
```

### 2. GitHub/GitLab Webhooks
```
Trigger: Webhook POST /api/git-webhook
→ Switch by event type:
  → pull_request.opened → Signal QA: pr_created
  → pull_request_review → Signal Tech Lead: review update
  → push → (optional) notify Tech Lead
```

### 3. Session Lifecycle
```
Trigger: Cron every 5 min
→ Check sleeping sessions
→ If session age > 8h → mark terminated
→ If queued tasks exist AND no rate limit → spawn next agent
```

### 4. Telegram → Tech Lead
```
Trigger: OpenClaw webhook (user message)
→ Route to Tech Lead session (resume or create)
→ Tech Lead processes, responds via notify_user()
```

---

## Верификация / Как тестировать

1. **Docker Compose up** — все сервисы поднимаются
2. **Setup Wizard** — проходит без ошибок, конфиг создан
3. **Telegram → Tech Lead** — отправить "Хочу сделать TODO-приложение"
   - Tech Lead должен задать уточняющие вопросы
   - Tech Lead должен создать задачи с тех. описанием в OpenProject
4. **Dev spawn** — разработчик создаёт ветку, пишет код, создаёт PR
5. **QA** — тестировщик пишет тесты, они проходят
6. **Tech Lead review** — ревью PR через subagent, approve
7. **Уведомление** — пользователь получает сообщение в Telegram

---

## Этапы реализации

### Phase 1: Фундамент
- Docker Compose с n8n, OpenProject, PostgreSQL
- orchestra-core: session manager + signal API
- MCP tools: signal_agent, openproject CRUD
- Промпт Tech Lead с Superpowers skills

### Phase 2: Коммуникация
- n8n workflows: signal router, session lifecycle
- OpenClaw интеграция (Telegram)
- Tech Lead ↔ Dev взаимодействие end-to-end

### Phase 3: Разработчики
- Dev agent spawning (per-task)
- Git integration (branches, PR creation)
- QA agent (тесты после PR)
- Tech Lead review workflow (через requesting-code-review subagent)

### Phase 4: Production-ready
- Setup wizard
- Rate limit handling + queue
- DevOps agent (CI/CD, deployment)
- Мониторинг и логирование
- Документация
