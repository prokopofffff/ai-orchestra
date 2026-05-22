import { spawn, type ChildProcess } from "node:child_process";
import { buildCodexCliArgs, writeCodexConfigToml } from "./codex-args";
import {
  createCodexNormalizer,
  parseCodexStream,
} from "./codex-jsonl-parser";
import {
  resolvePerRunBudgetUsd,
  resolveRunTimeoutMs,
} from "../../limits";
import { resolveCodexBin } from "../../bin-resolver";
import type {
  AgentRunOutcome,
  AgentRuntime,
} from "./types";

/** SIGTERM grace before SIGKILL — same shape as the Claude runtime. */
const KILL_GRACE_MS = 5_000;

/**
 * Runtime for the OpenAI Codex CLI. Drives `codex exec --json` in the
 * worktree, parses its JSONL stream, and normalizes events to the same
 * shape Claude emits — so the spawner's observer pipeline (logs +
 * observe-check enqueue + cost) doesn't care which provider produced
 * the run.
 *
 * Three Codex-specific concerns the runtime handles here (not in shared
 * code):
 *   - **MCP config via config.toml**: Codex reads MCP wiring from
 *     `$CODEX_HOME/config.toml`, not a flag. We write it per-spawn.
 *   - **No native budget cap**: enforce by watching token usage in the
 *     stream and aborting on threshold. (`turn.completed.usage` carries
 *     the running total.)
 *   - **Exit code 0 on auth failure**: detect via `turn.failed` / `error`
 *     events; spawner already surfaces these via the result event we
 *     synthesize in the parser.
 */
export const codexCliRuntime: AgentRuntime = {
  async run(input, onEvent): Promise<AgentRunOutcome> {
    const outcome: AgentRunOutcome = {};

    const maxBudgetUsd = resolvePerRunBudgetUsd(input.role, input.settings);
    const runTimeoutMs = resolveRunTimeoutMs(input.role, input.settings);

    // CODEX_HOME must already exist + carry auth.json — the resolver
    // (codex-auth) handles that path. We write the per-spawn MCP config
    // alongside it so the CLI's TOML loader picks it up.
    const codexHome = (input.spawnEnv ?? {}).CODEX_HOME;
    if (!codexHome) {
      // Defense in depth: the resolver should have set this. If it didn't
      // the run would silently fall back to ~/.codex which we explicitly
      // don't want (cross-project credential leakage).
      await onEvent({ type: "error", message: "Codex runtime invoked without CODEX_HOME in spawnEnv" });
      return { capExceeded: { kind: "aborted", detail: "Codex CODEX_HOME missing" } };
    }
    writeCodexConfigToml(codexHome, input.mcpServers);

    // Build the spawn env (process.env + per-spawn overrides). Same shape
    // as claude-cli — `undefined` strips a key (used to keep stale env
    // vars from leaking across spawns).
    const spawnEnvOverrides = input.spawnEnv ?? {};
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(spawnEnvOverrides)) {
      if (v === undefined) delete spawnEnv[k];
      else spawnEnv[k] = v;
    }

    const argv = buildCodexCliArgs({
      cwd: input.cwd,
      model: input.model,
      resumeSessionId: input.resumeSessionId,
    });

    let codexBin: string;
    try { codexBin = resolveCodexBin(); }
    catch (err) {
      await onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
      return { capExceeded: { kind: "aborted", detail: "Codex CLI не найден" } };
    }
    const child = spawn(codexBin, argv, {
      cwd: input.cwd,
      env: spawnEnv,
      // stdin must be passed (not "ignore") because we write the prompt
      // there. Codex reads from stdin when `--input` isn't on the command
      // line; this is the recommended way to ship long prompts safely.
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdin = child.stdin as NonNullable<typeof child.stdin>;
    const stdout = child.stdout as NonNullable<typeof child.stdout>;
    const stderr = child.stderr as NonNullable<typeof child.stderr>;

    // Pipe the user turn into stdin and close it. Codex treats EOF on
    // stdin as "no more user input" — necessary for one-shot non-interactive
    // mode.
    stdin.end(input.prompt);

    // Watchdog: per-role timeout aborts the run via SIGTERM/SIGKILL.
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      gracefulKill(child);
    }, runTimeoutMs);

    // External abort (admin "stop session" / interruptTechLead).
    const onAbort = (): void => gracefulKill(child);
    if (input.abortSignal.aborted) onAbort();
    else input.abortSignal.addEventListener("abort", onAbort, { once: true });

    // Drain stderr; codex --json puts diagnostics + retry logs there. Keep
    // the last ~4KB on hand for crash diagnostics — without it, a CLI that
    // exits before emitting any result event surfaces as "exit code N" with
    // no clue why (workspace path missing, model rejected, sandbox denied…).
    const STDERR_TAIL_CAP = 4096;
    let stderrTail = "";
    stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf-8")).slice(-STDERR_TAIL_CAP);
    });

    const normalizer = createCodexNormalizer({ model: input.model });
    let resultSeen = false;
    let exitedNormally = false;
    let runningCostUsd = 0;
    let budgetAborted = false;

    try {
      for await (const raw of parseCodexStream(stdout as unknown as AsyncIterable<Buffer>)) {
        for (const evt of normalizer.consume(raw)) {
          await onEvent(evt);
          if (evt.type === "result") {
            resultSeen = true;
            runningCostUsd = Math.max(runningCostUsd, evt.result.totalCostUsd);
          }
        }
        // Soft budget cap: codex has no native equivalent of Claude's
        // --max-budget-usd, so we enforce by watching the running cost
        // and SIGTERMing on overrun. Cheap to compute on each event.
        if (runningCostUsd > maxBudgetUsd && !budgetAborted) {
          budgetAborted = true;
          outcome.capExceeded = {
            kind: "budget",
            detail: `Run exceeded per-run budget $${maxBudgetUsd} (Codex)`,
          };
          gracefulKill(child);
        }
      }
      exitedNormally = true;
    } finally {
      clearTimeout(timeoutHandle);
      input.abortSignal.removeEventListener("abort", onAbort);
    }

    await waitForExit(child);

    if (timedOut) {
      outcome.capExceeded = {
        kind: "timeout",
        detail: `Run exceeded ${runTimeoutMs}ms`,
      };
    } else if (input.abortSignal.aborted && !resultSeen && !budgetAborted) {
      outcome.capExceeded = {
        kind: "aborted",
        detail: String(input.abortSignal.reason ?? "aborted"),
      };
    }

    if (!resultSeen && !outcome.capExceeded && exitedNormally) {
      const tail = stderrTail.trim();
      const suffix = tail ? ` — stderr: ${tail}` : "";
      await onEvent({
        type: "error",
        message: `codex CLI exited without a result event (exit code ${child.exitCode ?? "unknown"})${suffix}`,
      });
    }

    return outcome;
  },
};

function gracefulKill(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }
  }, KILL_GRACE_MS).unref();
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}
