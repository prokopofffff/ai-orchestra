import { parseModelSpec, type RuntimeProvider } from "@ai-orchestra/shared";
import { type Config, type AgentRole, getModelForRole } from "../../config";
import { claudeCliRuntime } from "./claude-cli";
import { codexCliRuntime } from "./codex-cli";
import { resolveClaudeAuth } from "../../claude-auth";
import { resolveCodexAuth } from "../../codex-auth";
import type { AgentRuntime } from "./types";

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

  const auth = provider === "codex"
    ? await resolveCodexAuth(args.projectId, args.settings)
    : await resolveClaudeAuth(args.projectId, args.settings, args.config);

  if (auth.reason) return { ok: false, reason: auth.reason };

  return {
    ok: true,
    resolved: {
      provider,
      model,
      runtime: RUNTIMES[provider],
      spawnEnv: auth.env,
    },
  };
}
