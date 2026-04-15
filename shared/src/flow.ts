/**
 * Domain flow: every (from-role, action, → to-role, → state-transition, → effect)
 * edge in the agent workflow.
 *
 * Single source of truth for:
 *   - backend route validation (flow-guard)
 *   - backend dispatch (dispatcher)
 *   - dashboard diagram + edge inspection
 *
 * Roles and states come from the schemas in this same package, so there's no
 * way for the visualization to disagree with the executor.
 */

import type { AgentRole, TaskState } from "./index";

// ─── Types ─────────────────────────────────────────────────────────────────

export type SenderRole = AgentRole | "system";
export type RecipientRole = AgentRole | "user";

/** Where the signal goes after dispatch. */
export type Target =
  | { kind: "role"; role: RecipientRole }
  | { kind: "task-assignee" }   // strict: requires task.assignee_role; else fail
  | { kind: "addressed-role" }  // task.assignee_role if available, else signal.to
  | { kind: "user" };

/** What happens when the signal is accepted. */
export type Effect =
  | { kind: "spawn" }              // enqueue agent for resolved target
  | { kind: "auto-unblock" }       // notify TL + checkUnblocked, no spawn
  | { kind: "notify-user" }        // user-facing message
  | { kind: "store-only" };        // record signal, no further action

export type Edge = {
  action: string;
  /** Roles that may emit this signal. */
  allowedFrom: SenderRole[];
  target: Target;
  /** Optional state transition. `from` lists allowed source states. */
  transition?: { from: TaskState[]; to: TaskState };
  effect: Effect;
  description: string;
};

// ─── Communication permissions ─────────────────────────────────────────────
//
// Independent of action semantics — answers "can role A address role B at all?".
// An emitted signal needs BOTH this check (signal.to ∈ routePermissions[signal.from])
// AND the per-action check (signal.from ∈ edge.allowedFrom).

export const routePermissions: Record<SenderRole, RecipientRole[]> = {
  "tech-lead": ["designer", "frontend", "backend", "qa", "devops", "user"],
  designer:    ["tech-lead", "user"],
  frontend:    ["tech-lead", "qa", "user"],
  backend:     ["tech-lead", "qa", "user"],
  qa:          ["tech-lead", "user"],
  devops:      ["tech-lead", "user"],
  system:      ["tech-lead", "user"],
};

// ─── The flow ──────────────────────────────────────────────────────────────

const dev: SenderRole[] = ["frontend", "backend"];
const allAgents: SenderRole[] = ["tech-lead", "designer", "frontend", "backend", "qa", "devops"];

export const flow: Edge[] = [
  // ── Tech Lead → Designer ──────────────────────────────────────────────
  {
    action: "create_design_system",
    allowedFrom: ["tech-lead"],
    target: { kind: "role", role: "designer" },
    transition: { from: ["described"], to: "designing" },
    effect: { kind: "spawn" },
    description: "TL asks Designer to build the project's design system",
  },
  {
    action: "create_design",
    allowedFrom: ["tech-lead"],
    target: { kind: "role", role: "designer" },
    transition: { from: ["described"], to: "designing" },
    effect: { kind: "spawn" },
    description: "TL asks Designer to design a specific feature",
  },

  // ── Designer → Tech Lead ──────────────────────────────────────────────
  {
    action: "design_system_ready",
    allowedFrom: ["designer"],
    target: { kind: "role", role: "tech-lead" },
    transition: { from: ["designing"], to: "design_ready" },
    effect: { kind: "auto-unblock" },
    description: "Design system done — auto-notify TL, unblock dependent tasks",
  },
  {
    action: "design_ready",
    allowedFrom: ["designer"],
    target: { kind: "role", role: "tech-lead" },
    transition: { from: ["designing"], to: "design_ready" },
    effect: { kind: "auto-unblock" },
    description: "Feature design done — auto-notify TL, unblock dependent tasks",
  },

  // ── Tech Lead → Dev ───────────────────────────────────────────────────
  {
    action: "assign_dev",
    allowedFrom: ["tech-lead"],
    target: { kind: "task-assignee" },
    transition: { from: ["described", "design_ready", "failed", "revisions"], to: "in_development" },
    effect: { kind: "spawn" },
    description: "TL hands the task to its assigned dev role",
  },

  // ── Dev → Tech Lead ───────────────────────────────────────────────────
  {
    action: "pr_created",
    allowedFrom: dev,
    target: { kind: "role", role: "tech-lead" },
    transition: { from: ["in_development", "revisions", "in_review"], to: "pr_created" },
    effect: { kind: "spawn" },
    description: "Dev opened a PR — TL reviews",
  },

  // ── Tech Lead PR review outcomes ──────────────────────────────────────
  {
    action: "pr_approved",
    allowedFrom: ["tech-lead"],
    target: { kind: "user" },
    transition: { from: ["pr_created", "in_review"], to: "approved" },
    effect: { kind: "notify-user" },
    description: "TL approved the PR",
  },
  {
    action: "pr_changes_requested",
    allowedFrom: ["tech-lead"],
    target: { kind: "addressed-role" },
    transition: { from: ["pr_created", "in_review"], to: "revisions" },
    effect: { kind: "spawn" },
    description: "TL requested changes — resume the dev",
  },

  // ── QA → Tech Lead ────────────────────────────────────────────────────
  {
    action: "tests_passed",
    allowedFrom: ["qa"],
    target: { kind: "role", role: "tech-lead" },
    transition: { from: ["in_testing"], to: "tested" },
    effect: { kind: "auto-unblock" },
    description: "QA passed — auto-notify TL, unblock dependents",
  },
  {
    action: "tests_failed",
    allowedFrom: ["qa"],
    target: { kind: "role", role: "tech-lead" },
    transition: { from: ["designing", "in_development", "in_testing", "revisions"], to: "failed" },
    effect: { kind: "spawn" },
    description: "QA failed — TL decides next step",
  },

  // ── Tech Lead → DevOps ────────────────────────────────────────────────
  {
    action: "setup_cicd",
    allowedFrom: ["tech-lead"],
    target: { kind: "role", role: "devops" },
    effect: { kind: "spawn" },
    description: "TL asks DevOps to wire CI/CD",
  },
  {
    action: "deploy",
    allowedFrom: ["tech-lead"],
    target: { kind: "role", role: "devops" },
    effect: { kind: "spawn" },
    description: "TL asks DevOps to deploy",
  },

  // ── DevOps → Tech Lead ────────────────────────────────────────────────
  {
    action: "deploy_done",
    allowedFrom: ["devops"],
    target: { kind: "role", role: "tech-lead" },
    effect: { kind: "store-only" },
    description: "DevOps reports deploy done",
  },
  {
    action: "cicd_ready",
    allowedFrom: ["devops"],
    target: { kind: "role", role: "tech-lead" },
    effect: { kind: "store-only" },
    description: "DevOps reports CI/CD wired",
  },

  // ── Q&A ───────────────────────────────────────────────────────────────
  {
    action: "question",
    // tech-lead included for parity with current allowedActions table; rarely used.
    allowedFrom: allAgents,
    target: { kind: "role", role: "tech-lead" },
    effect: { kind: "spawn" },
    description: "Agent asks TL — TL is spawned to answer",
  },
  {
    action: "answer",
    allowedFrom: ["tech-lead"],
    target: { kind: "addressed-role" },
    effect: { kind: "spawn" },
    description: "TL answers — resume the asker",
  },

  // ── User-facing ───────────────────────────────────────────────────────
  {
    action: "task_done",
    allowedFrom: ["tech-lead"],
    target: { kind: "user" },
    effect: { kind: "notify-user" },
    description: "TL declares task done",
  },
  {
    action: "notify",
    allowedFrom: allAgents,
    target: { kind: "user" },
    effect: { kind: "notify-user" },
    description: "Generic user notification",
  },
  {
    action: "escalate",
    allowedFrom: allAgents,
    target: { kind: "user" },
    effect: { kind: "notify-user" },
    description: "Agent escalates to user",
  },

  // ── System ────────────────────────────────────────────────────────────
  {
    action: "task_blocked",
    allowedFrom: ["system"],
    target: { kind: "role", role: "tech-lead" },
    effect: { kind: "store-only" },
    description: "Task is blocked by dependencies",
  },
  {
    action: "task_unblocked",
    allowedFrom: ["system"],
    target: { kind: "task-assignee" },
    effect: { kind: "spawn" },
    description: "Dependencies cleared — auto-resume the assignee",
  },
];

// ─── Implicit transitions (not tied to a specific action) ─────────────────
//
// "Cancelled" is reachable from any active state.
// "Tested" advances to in_review/merged without an action edge.
// Etc. These complete the state machine.

const implicitTransitions: Partial<Record<TaskState, TaskState[]>> = {
  new:            ["described", "cancelled"],
  described:      ["cancelled"],
  designing:      ["cancelled"],
  design_ready:   ["cancelled"],
  in_development: ["cancelled"],
  pr_created:     ["in_testing", "approved", "cancelled"],
  revisions:      ["in_development", "cancelled"],
  in_testing:     ["in_development", "cancelled"],
  tested:         ["in_review", "merged"],
  in_review:      ["in_development", "cancelled"],
  approved:       ["merged", "in_testing"],
  merged:         ["closed"],
  failed:         ["new", "cancelled"],
  cancelled:      ["new"],
};

// ─── Derived getters ───────────────────────────────────────────────────────

export function getEdge(action: string): Edge | undefined {
  return flow.find((e) => e.action === action);
}

export function isRouteAllowed(from: SenderRole, to: RecipientRole): boolean {
  return routePermissions[from]?.includes(to) ?? false;
}

export function isActionAllowedFrom(from: SenderRole, action: string): boolean {
  const edge = getEdge(action);
  return edge ? edge.allowedFrom.includes(from) : false;
}

export function getActionsFor(from: SenderRole): string[] {
  return flow.filter((e) => e.allowedFrom.includes(from)).map((e) => e.action);
}

export function getTargetState(action: string): TaskState | null {
  return getEdge(action)?.transition?.to ?? null;
}

/**
 * All states reachable from `state`, derived as the union of:
 *   - action edges where `state ∈ transition.from` → their `transition.to`
 *   - implicit transitions (cancellation, terminal flows)
 */
export function getValidTransitions(state: string): TaskState[] {
  if (!knownState(state)) return [];
  const fromActions = flow
    .filter((e) => e.transition?.from.includes(state))
    .map((e) => e.transition!.to);
  const implicit = implicitTransitions[state] ?? [];
  const out: TaskState[] = [];
  for (const t of [...fromActions, ...implicit]) {
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export function getAllStates(): TaskState[] {
  return Object.keys(implicitTransitions) as TaskState[];
}

export function knownState(state: string): state is TaskState {
  return state in implicitTransitions;
}
