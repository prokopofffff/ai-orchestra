import { appendLog } from "./logger";
import { log } from "./obs";

/**
 * Thrown when a preflight check refuses to spawn the agent and has
 * *already* notified the user with an actionable escalate signal. The
 * background-error logger downgrades these to a quiet info line so the
 * user doesn't see a red [agent-run] fatal next to the friendly
 * "initialize a git repo here" message they just got in chat.
 */
export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

/**
 * Log an error from a background operation that can't throw.
 * Logs through the structured logger + agent_logs DB table. Never throws.
 * `PreflightError` instances are downgraded to info: the user-facing
 * escalate signal is the authoritative message; the duplicate error log
 * is noise.
 */
export function logBackgroundError(
  context: string,
  err: unknown,
  projectId?: string,
): void {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof PreflightError) {
    log.info({ bgContext: context, projectId, reason: message }, `preflight: ${context}`);
    return;
  }
  log.error({ err, bgContext: context, projectId }, `background: ${context}`);
  if (projectId) {
    appendLog(projectId, null, "system", "error", `[${context}] ${message}`);
  }
}

/**
 * Wrap a promise that runs in background (fire-and-forget).
 * Logs errors instead of swallowing them.
 */
export function background(
  promise: Promise<unknown>,
  context: string,
  projectId?: string,
): void {
  promise.catch((err) => logBackgroundError(context, err, projectId));
}
