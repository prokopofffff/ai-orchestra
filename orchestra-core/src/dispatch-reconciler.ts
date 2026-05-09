import { z } from "zod";
import { registerHandler, registerCron } from "./scheduler";
import { reconcileOrphanedTasks } from "./dispatcher";
import { loadConfig } from "./config";
import { log } from "./obs";

/**
 * Periodic safety net for spawns that didn't go through. Two cases this
 * catches the static startup `reconcileOrphanedTasks` call can't:
 *
 *   1. Concurrency cap was full when the signal arrived; dispatcher returned
 *      `dispatched: false`, signal sits in DB. Once existing sessions
 *      terminate, the task is now an orphan in an active state — this picks
 *      it up.
 *   2. Process is long-running and operator manually unfroze a task — the
 *      task moves to active state with no running session, same shape.
 */
const RECONCILE_KIND = "dispatch-reconciler:scan";

registerHandler(RECONCILE_KIND, z.object({}), async () => {
  try {
    await reconcileOrphanedTasks(loadConfig());
  } catch (err) {
    log.warn({ err }, "dispatch-reconciler: scan failed");
  }
});

export async function startDispatchReconciler(): Promise<void> {
  await registerCron({
    key: "dispatch-reconciler",
    kind: RECONCILE_KIND,
    intervalSeconds: 60,
  });
  log.info("dispatch-reconciler scheduled (every 60s)");
}

export function stopDispatchReconciler(): void {}
