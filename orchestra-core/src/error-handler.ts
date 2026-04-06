import { appendLog } from "./logger";

/**
 * Log an error from a background operation that can't throw.
 * Logs to console + agent_logs table. Never throws.
 */
export function logBackgroundError(
  context: string,
  err: unknown,
  projectId?: string,
): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${context}] ${message}`);
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
