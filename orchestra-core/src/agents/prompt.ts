import fs from "node:fs";
import path from "node:path";
import { getAgentConfig } from "./configs";
import type { AgentRole } from "../config";

const PROMPTS_DIR = path.join(process.cwd(), "prompts");

/**
 * Load the role's system prompt from `prompts/<file>.md`. Honors
 * `fallbackPromptFile` for the designer/no-pencil case (and any future
 * role that needs a degraded variant when an external dep is missing).
 *
 * Returns "" if no file is found — assembly will still proceed; the agent
 * just runs with the bootstrap context as its only system context.
 */
export function loadSystemPrompt(
  role: AgentRole,
  opts: { pencilEnabled?: boolean } = {},
): string {
  const cfg = getAgentConfig(role);
  const file = (role === "designer" && !opts.pencilEnabled && cfg.fallbackPromptFile)
    ? cfg.fallbackPromptFile
    : cfg.promptFile;
  const promptPath = path.join(PROMPTS_DIR, `${file}.md`);
  return fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf-8") : "";
}

/**
 * Render the role's scope as a prompt section. Empty string for unrestricted
 * roles (tech-lead) so we don't pollute their context with vacuous rules.
 *
 * The git pre-commit scope hook (`scope-enforcer`) is the hard boundary;
 * this is a soft instruction so the agent doesn't try out-of-scope edits
 * in the first place.
 */
export function buildScopeRules(role: AgentRole): string {
  const { scope } = getAgentConfig(role);
  const unrestricted =
    scope.allowed.length === 1 && scope.allowed[0] === "**/*" && scope.denied.length === 0;
  if (unrestricted) return "";

  return [
    "\n## Scope Rules",
    `You may ONLY modify files in: ${scope.allowed.join(", ")}`,
    scope.denied.length ? `You must NOT modify files in: ${scope.denied.join(", ")}` : "",
    "You may delete unnecessary files within your allowed scope.",
    "Before creating a PR, run `git rebase main`. If there are conflicts, escalate to tech-lead.",
  ].filter(Boolean).join("\n");
}

/**
 * Stitch the prompt parts into a single string. Empty parts are skipped so
 * callers don't have to conditionally pass `""`.
 */
export function assemblePrompt(parts: {
  systemPrompt: string;
  scope?: string;
  bootstrap: string;
  tail?: string;
}): string {
  const sections = [
    parts.systemPrompt,
    parts.scope,
    "\n---\n",
    parts.bootstrap,
    parts.tail,
  ].filter((s): s is string => !!s && s.length > 0);
  return sections.join("\n");
}
