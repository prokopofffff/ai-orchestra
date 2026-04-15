/**
 * Backwards-compat re-export. The flow definition lives in
 * `@ai-orchestra/shared/flow` so the dashboard can render exactly what
 * the backend executes.
 */
export * from "@ai-orchestra/shared";
export type { Edge, Target, Effect, SenderRole, RecipientRole } from "@ai-orchestra/shared";
