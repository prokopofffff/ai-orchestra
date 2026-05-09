import type { AgentRole, Limits, ProjectSettings } from "@ai-orchestra/shared";
import { LimitsSchema } from "@ai-orchestra/shared";

/**
 * In-code defaults for project safety limits. Per-project overrides live in
 * `projects.settings.limits` (LimitsSchema). Tune these here when reasoning
 * about thresholds; ship overrides via DB to react to incidents.
 */
export const DEFAULT_LIMITS = {
  dailyCostUsd: 20,
  perRunBudgetUsd: {
    "tech-lead": 5,
    designer: 2,
    frontend: 2,
    backend: 2,
    qa: 2,
    devops: 2,
  } satisfies Record<AgentRole, number>,
  maxRevisions: 5,
  maxFails: 3,
  maxSignalsPerTask: 200,
  maxQaDepth: 5,
  maxConcurrentSessions: 4,
  runTimeoutMs: {
    "tech-lead": 2 * 60 * 60 * 1000,
    designer: 30 * 60 * 1000,
    frontend: 30 * 60 * 1000,
    backend: 30 * 60 * 1000,
    qa: 30 * 60 * 1000,
    devops: 30 * 60 * 1000,
  } satisfies Record<AgentRole, number>,
} as const;

/**
 * Parse a row's `settings` JSON column into project Limits, surviving
 * malformed payloads by falling back to an empty object — defaults apply.
 */
export function parseLimits(settings: unknown): Limits {
  if (!settings || typeof settings !== "object") return {};
  const raw = (settings as Record<string, unknown>).limits;
  if (!raw) return {};
  const parsed = LimitsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

export function resolveDailyCostCap(settings: ProjectSettings | unknown): number {
  const limits = parseLimits(settings);
  return limits.dailyCostUsd ?? DEFAULT_LIMITS.dailyCostUsd;
}

export function resolvePerRunBudgetUsd(role: AgentRole, settings: unknown): number {
  const limits = parseLimits(settings);
  return limits.perRunBudgetUsd?.[role] ?? DEFAULT_LIMITS.perRunBudgetUsd[role];
}

export function resolveMaxRevisions(settings: unknown): number {
  return parseLimits(settings).maxRevisions ?? DEFAULT_LIMITS.maxRevisions;
}

export function resolveMaxFails(settings: unknown): number {
  return parseLimits(settings).maxFails ?? DEFAULT_LIMITS.maxFails;
}

export function resolveMaxSignalsPerTask(settings: unknown): number {
  return parseLimits(settings).maxSignalsPerTask ?? DEFAULT_LIMITS.maxSignalsPerTask;
}

export function resolveRunTimeoutMs(role: AgentRole, settings: unknown): number {
  return parseLimits(settings).runTimeoutMs?.[role] ?? DEFAULT_LIMITS.runTimeoutMs[role];
}

export function resolveMaxQaDepth(settings: unknown): number {
  return parseLimits(settings).maxQaDepth ?? DEFAULT_LIMITS.maxQaDepth;
}

export function resolveMaxConcurrentSessions(settings: unknown): number {
  return parseLimits(settings).maxConcurrentSessions ?? DEFAULT_LIMITS.maxConcurrentSessions;
}
