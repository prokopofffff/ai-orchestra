import type { TourStep } from "./Tour";
import type { OnboardingTabKey } from "../api";

/**
 * Per-route coachmark tour content. Each entry is a sequence of steps
 * that get pointed at via `data-tour="…"` attributes on the rendered DOM.
 * Tour key matches the route path segment so the host can pick the right
 * one from the current URL.
 */
export const TOURS: Record<OnboardingTabKey, TourStep[]> = {
  kanban: [
    {
      anchor: '[data-tour="kanban.create-task"]',
      title: "Create a task",
      body: "Drop a one-liner here and AI Orchestra spawns the right agent for it. Type, priority, and assignee can all be set inline — leave them at defaults and Tech Lead picks.",
      placement: "bottom",
    },
    {
      anchor: '[data-tour="kanban.create-project"]',
      title: "Switch or add a project",
      body: "Each project is its own repo / local directory with its own team of agents. New users start with one — add more from here.",
      placement: "bottom",
    },
    {
      anchor: '[data-tour="kanban.board"]',
      title: "Live status board",
      body: "Tasks flow left to right: Backlog → Design → Development → Testing → Review → Done. The Blocked column collects tasks that hit the safety caps or got cancelled.",
      placement: "top",
    },
    {
      title: "Click any task to open it",
      body: "Inside you'll see state, PR link, comments, and the frozen-reason banner if a safety cap tripped. From there you can also unfreeze a stuck task.",
      placement: "center",
    },
  ],

  chat: [
    {
      anchor: '[data-tour="chat.sidebar"]',
      title: "Conversations per project",
      body: "Switch between project conversations from the sidebar. Each project gets its own thread with Tech Lead.",
      placement: "right",
    },
    {
      anchor: '[data-tour="chat.input"]',
      title: "Talk to Tech Lead",
      body: "Describe what you want — a feature, a bug fix, a refactor. Tech Lead decomposes the work, picks the right specialist agents, and reports back here as things ship.",
      placement: "top",
    },
    {
      title: "System messages",
      body: "Anything Tech Lead delegates or completes shows up as a system message in this stream. The full audit trail lives on the Signals tab.",
      placement: "center",
    },
  ],

  signals: [
    {
      anchor: '[data-tour="signals.feed"]',
      title: "Every event in one stream",
      body: "Signals are the language agents speak: `assign_dev`, `pr_created`, `tests_failed`, `escalate`, etc. Each one is gated by flow-guard and stored here as the source of truth.",
      placement: "center",
    },
    {
      title: "Filters by role and project",
      body: "Use the filters to narrow down to a specific agent or a specific project. Anything tagged `rejected` is something flow-guard refused — often an unsafe transition or a cap-exceeded event.",
      placement: "center",
    },
  ],

  agents: [
    {
      anchor: '[data-tour="agents.graph"]',
      title: "Live agent graph",
      body: "Active agents and the signals connecting them, updated in real time. Pulsing nodes are currently running; arrows are recent signals between roles.",
      placement: "bottom",
    },
    {
      anchor: '[data-tour="agents.cards"]',
      title: "Per-role status cards",
      body: "Each agent role with its current session, recent activity, and queued work. Click a card to see logs for that agent.",
      placement: "top",
    },
    {
      anchor: '[data-tour="agents.cost"]',
      title: "Today's spend",
      body: "Cost so far this 24h window with a breakdown by role and model. Goes red when you cross the project's daily cap.",
      placement: "left",
    },
  ],

  flow: [
    {
      anchor: '[data-tour="flow.toggle"]',
      title: "Two views of the workflow",
      body: "State Machine shows the task lifecycle: every state a task can be in and the signals that move it forward. Role Graph shows which agent can talk to which.",
      placement: "bottom",
    },
    {
      anchor: '[data-tour="flow.canvas"]',
      title: "The contract agents must follow",
      body: "Both diagrams come from the same source-of-truth in `shared/flow.ts`. If an agent tries to send a signal not in this graph, flow-guard rejects it — that's how we keep things sane.",
      placement: "top",
    },
  ],

  logs: [
    {
      anchor: '[data-tour="logs.list"]',
      title: "Raw output from agent runs",
      body: "Every line stdout/stderr, every check result, every SDK message ends up here. Useful when an agent does something surprising — you can replay exactly what it saw and did.",
      placement: "center",
    },
    {
      title: "Filter by role and level",
      body: "`error` for problems, `system` for orchestration events (start/end/timeout/budget), `stdout` for normal output. Narrow down to a specific agent or session as needed.",
      placement: "center",
    },
  ],

  settings: [
    {
      anchor: '[data-tour="settings.tabs"]',
      title: "Project · Agents · Checks · Members · Limits · System",
      body: "Project basics on the first tab — including the Telegram bot for this project (each project gets its own). Agents tab picks model + effort per role. Checks defines per-file lint/test commands. Members invites people. Limits sets safety caps. System is global Claude / GitHub auth.",
      placement: "bottom",
    },
    {
      title: "All settings are per-project",
      body: "Except System — that's orchestra-wide. Every other tab applies to the currently-selected project, including model overrides, member roles, cost caps, and the Telegram bot token.",
      placement: "center",
    },
  ],

  profile: [
    {
      title: "Your account",
      body: "Username, email, password. Logout from here too. Project membership invites go to the email registered on this page.",
      placement: "center",
    },
  ],
};
