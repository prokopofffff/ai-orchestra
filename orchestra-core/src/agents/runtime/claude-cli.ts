import { spawn, type ChildProcess } from "node:child_process";
import { buildClaudeCliArgs, buildClaudeSettings } from "./claude-args";
import { normalizeClaudeStream } from "./claude-jsonl-parser";
import { resolvePerRunBudgetUsd, resolveRunTimeoutMs } from "../../limits";
import { resolveClaudeBin } from "../../bin-resolver";
import type {
  AgentRunOutcome,
  AgentRuntime,
} from "./types";

/**
 * Grace window between SIGTERM and SIGKILL. The CLI tries to flush its
 * JSON stream and close the API connection cleanly when given a chance;
 * 5s is generous but bounded.
 */
const KILL_GRACE_MS = 5_000;

/**
 * One implementation: drive the `claude` binary in headless stream-json
 * mode. The two callers (agent-spawner for one-shot dev runs, tech-lead-
 * dispatcher for user chat) plug their own observer in and react to the
 * normalized event stream.
 *
 * What used to be in-process (canUseTool, PostToolUse hook callback,
 * AbortController plumbing) is now expressed as either flags + settings.json
 * (sandbox, permissions.deny) or stream-observer logic (deny streak,
 * observe-check enqueue) in the caller.
 */
export const claudeCliRuntime: AgentRuntime = {
  async run(input, onEvent): Promise<AgentRunOutcome> {
    const outcome: AgentRunOutcome = {};

    const maxBudgetUsd = resolvePerRunBudgetUsd(input.role, input.settings);
    const runTimeoutMs = resolveRunTimeoutMs(input.role, input.settings);

    // Build the spawn env: process.env + per-spawn overrides (undefined = delete).
    // The auth resolver populates ANTHROPIC_API_KEY or CLAUDE_CONFIG_DIR
    // based on the project's mode. Per-spawn isolation prevents project A's
    // key leaking into project B's run — the failure mode that drove the
    // recent "per-project creds only" security tightening.
    const spawnEnvOverrides = input.spawnEnv ?? {};
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(spawnEnvOverrides)) {
      if (v === undefined) delete spawnEnv[k];
      else spawnEnv[k] = v;
    }
    // Claude CLI refuses --permission-mode bypassPermissions when running as
    // root unless this flag is set ("cannot be used with root/sudo
    // privileges for security reasons"). The orchestra-core container runs
    // as root by default; IS_SANDBOX is the documented escape hatch for
    // containerized deployments. Setting it unconditionally is fine —
    // orchestra ALWAYS spawns under sandboxing (docker on the server, the
    // git worktree on dev machines).
    spawnEnv.IS_SANDBOX = "1";

    // Bare mode = strictly env-var auth (no keychain, no OAuth). Use it
    // when this spawn has ANTHROPIC_API_KEY set; otherwise let the CLI
    // read credentials from CLAUDE_CONFIG_DIR (subscription mode).
    const bare = !!spawnEnv.ANTHROPIC_API_KEY;

    const settings = buildClaudeSettings({ role: input.role, cwd: input.cwd });

    const { argv } = buildClaudeCliArgs({
      role: input.role,
      model: input.model,
      effort: input.effort,
      sessionId: input.sessionId,
      resumeSessionId: input.resumeSessionId,
      maxBudgetUsd,
      pencilEnabled: input.pencilEnabled,
      mcpServers: input.mcpServers,
      bare,
    });
    argv.push("--settings", JSON.stringify(settings));
    // Prompt last — positional. Long prompts stay under argv-length limits
    // (~256KB on macOS / Linux). Falls back to stdin only if we hit that.
    argv.push(input.prompt);

    let claudeBin: string;
    try { claudeBin = resolveClaudeBin(); }
    catch (err) {
      await onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
      return { capExceeded: { kind: "aborted", detail: "Claude CLI не найден" } };
    }
    const child = spawn(claudeBin, argv, {
      cwd: input.cwd,
      env: spawnEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // stdio: ['ignore', 'pipe', 'pipe'] means stdout/stderr are non-null
    // Readable streams; stdin is null. The Node typings don't have a narrow
    // for this combo, so we assert what we know to be true.
    const stdout = child.stdout as NonNullable<typeof child.stdout>;
    const stderr = child.stderr as NonNullable<typeof child.stderr>;

    // Watchdog: hard timeout that aborts the run if it overruns the role's
    // budget. The signal mirrors what the SDK's AbortController did.
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      gracefulKill(child, `run timeout after ${runTimeoutMs}ms`);
    }, runTimeoutMs);

    // External abort (admin "stop session" / interruptTechLead): SIGTERM
    // the child immediately; SIGKILL after the grace window if it lingers.
    const onAbort = (): void => {
      gracefulKill(child, String(input.abortSignal.reason ?? "aborted"));
    };
    if (input.abortSignal.aborted) onAbort();
    else input.abortSignal.addEventListener("abort", onAbort, { once: true });

    // Drain stderr but keep the last ~4KB on hand for crash diagnostics —
    // when Claude exits non-zero before emitting a result event, the only
    // signal we have is whatever it printed to stderr. Without this we
    // surfaced "exit code 1" with no context. Cap the buffer so a chatty
    // CLI run doesn't accumulate unbounded memory across long sessions.
    const STDERR_TAIL_CAP = 4096;
    let stderrTail = "";
    stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf-8")).slice(-STDERR_TAIL_CAP);
    });

    let resultSeen = false;
    let exitedNormally = false;

    try {
      const stream = stdout as unknown as AsyncIterable<Buffer>;
      for await (const evt of normalizeClaudeStream(stream)) {
        await onEvent(evt);
        if (evt.type === "result") {
          resultSeen = true;
          if (evt.result.subtype === "error_max_budget_usd") {
            outcome.capExceeded = {
              kind: "budget",
              detail: `Run exceeded per-run budget $${maxBudgetUsd}`,
            };
          }
        }
      }
      exitedNormally = true;
    } finally {
      clearTimeout(timeoutHandle);
      input.abortSignal.removeEventListener("abort", onAbort);
    }

    // Wait for the child to actually exit so we don't leak processes.
    // `for await` on stdout returns when stdout closes; the child may still
    // be flushing or in shutdown.
    await waitForExit(child);

    if (timedOut) {
      outcome.capExceeded = {
        kind: "timeout",
        detail: `Run exceeded ${runTimeoutMs}ms`,
      };
    } else if (input.abortSignal.aborted && !resultSeen) {
      outcome.capExceeded = {
        kind: "aborted",
        detail: String(input.abortSignal.reason ?? "aborted"),
      };
    }

    // If the stream ended without a result event AND we didn't trigger an
    // abort, treat that as a CLI crash — surface it so the caller logs an
    // error rather than silently completing.
    if (!resultSeen && !outcome.capExceeded && exitedNormally) {
      const tail = stderrTail.trim();
      const suffix = tail ? ` — stderr: ${tail}` : "";
      await onEvent({
        type: "error",
        message: `claude CLI exited without a result event (exit code ${child.exitCode ?? "unknown"})${suffix}`,
      });
    }

    return outcome;
  },
};

function gracefulKill(child: ChildProcess, reason: string): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // process may have already exited between the check and the kill
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }
  }, KILL_GRACE_MS).unref();
  // The reason is informational — the caller decides whether to record it
  // as a timeout, abort, or budget cap based on which trigger fired.
  void reason;
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

