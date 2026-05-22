import { parseModelSpec, type RuntimeProvider } from "@ai-orchestra/shared";
import { type Config, type AgentRole, getModelForRole } from "../../config";
import { claudeCliRuntime } from "./claude-cli";
import { codexCliRuntime } from "./codex-cli";
import { resolveClaudeAuth, type ClaudeAuthResolution } from "../../claude-auth";
import { resolveCodexAuth, type CodexAuthResolution } from "../../codex-auth";
import { log } from "../../obs";
import type { AgentRuntime } from "./types";

/**
 * Fallback model when we auto-swap a Claude-configured role onto Codex
 * because Codex is the only authorized provider. Matches the canonical
 * model used by the cost normalizer (codex-jsonl-parser FALLBACK_RATE).
 */
const CODEX_FALLBACK_MODEL = "gpt-5-codex";

/**
 * Resolve which provider+model+runtime+auth to use for a given (project, role)
 * spawn. Single entry point so the spawner and TL dispatcher both go through
 * one place — adding a new provider only touches the registry below.
 *
 * Returns `reason` (and a null runtime) when the project isn't yet usable
 * (auth not configured). Caller short-circuits with the reason instead of
 * letting the CLI 401 mid-stream.
 */
export type ResolvedRuntime = {
  provider: RuntimeProvider;
  /** Provider-native model id (e.g. "opus" or "gpt-5-codex"). */
  model: string;
  runtime: AgentRuntime;
  /** Env vars to pass into the spawn via AgentRunInput.spawnEnv. */
  spawnEnv: Record<string, string | undefined>;
};

export type ResolveResult =
  | { ok: true; resolved: ResolvedRuntime }
  | { ok: false; reason: string };

const RUNTIMES: Record<RuntimeProvider, AgentRuntime> = {
  claude: claudeCliRuntime,
  codex: codexCliRuntime,
};

export async function resolveRuntimeForRole(args: {
  projectId: string;
  role: AgentRole;
  settings: unknown;
  config: Config;
}): Promise<ResolveResult> {
  const rawSpec = getModelForRole(args.config, args.role, args.settings as Record<string, unknown>);
  const { provider, model } = parseModelSpec(rawSpec);

  const primary = await authFor(provider, args);
  if (!primary.reason) {
    return { ok: true, resolved: { provider, model, runtime: RUNTIMES[provider], spawnEnv: primary.env } };
  }

  // Auto-swap: configured provider isn't authorized for this project. If
  // the *other* provider is, run all roles through it instead of bouncing
  // every dispatch off a "not authorized" preflight. Concrete case: user
  // only logged into Codex on a project whose tech-lead defaults to Opus —
  // we route the whole team to Codex rather than gating on a second login.
  const other: RuntimeProvider = provider === "claude" ? "codex" : "claude";
  const fallback = await authFor(other, args);
  if (!fallback.reason) {
    const fallbackModel = other === "codex"
      ? CODEX_FALLBACK_MODEL
      // Bypass settings.models[role] (it points at the now-unavailable provider)
      // so we get the role's environment default model (opus/sonnet/haiku).
      : parseModelSpec(getModelForRole(args.config, args.role, undefined)).model;
    log.info(
      { projectId: args.projectId, role: args.role, from: provider, to: other, fallbackModel },
      "auto-swapped agent provider — configured provider not authorized, fell back to the authorized one",
    );
    return {
      ok: true,
      resolved: { provider: other, model: fallbackModel, runtime: RUNTIMES[other], spawnEnv: fallback.env },
    };
  }

  // Neither provider is authorized — surface the configured one's reason
  // so the user is guided toward the auth they presumably intended to set up.
  return { ok: false, reason: primary.reason };
}

function authFor(
  provider: RuntimeProvider,
  args: { projectId: string; settings: unknown; config: Config },
): Promise<ClaudeAuthResolution | CodexAuthResolution> {
  return provider === "codex"
    ? resolveCodexAuth(args.projectId, args.settings)
    : resolveClaudeAuth(args.projectId, args.settings, args.config);
}
