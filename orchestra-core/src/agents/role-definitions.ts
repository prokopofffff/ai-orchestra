import fs from "node:fs";
import path from "node:path";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRole } from "../config";
import { agentConfigs } from "./configs";
import { loadSystemPrompt, buildScopeRules } from "./prompt";

/**
 * Build SDK-native AgentDefinition for a role. One source of truth instead
 * of three (prompts/<role>.md + configs.ts + the manual canUseTool deny
 * we maintained in sdk-runner): the markdown stays in prompts/, but the
 * tool restrictions, model hints, memory mode, and the "what is this role
 * for" description all live here so the SDK can enforce them natively.
 *
 * The bootstrap context (current task, pending signals, etc) is NOT in
 * `prompt` — that stays the per-run user turn the spawner passes to
 * query(). agent.prompt is the static system prompt only.
 */
const ROLE_DESCRIPTIONS: Record<AgentRole, string> = {
  "tech-lead": "Plans and decomposes work, delegates to specialists, reviews PRs. Never writes code or designs.",
  designer: "Owns the visual layer: designs in Pencil, design system, UX flows.",
  frontend: "Implements UI components and client-side integration with the backend API.",
  backend: "Implements server-side APIs, business logic, persistence.",
  qa: "Writes and runs tests, files regressions, gates merges.",
  devops: "CI/CD, deployment configs, infrastructure as code.",
};

// Shared "what is AI Orchestra" preamble loaded once. Concatenated into
// every role's prompt so they all speak the same signal/task vocabulary
// without us trying to ship it as an SDK skill (skills resolve from
// .claude/skills/ paths that don't exist inside the ephemeral worktrees
// we spawn into).
const ORCHESTRA_PRELUDE = (() => {
  const p = path.join(process.cwd(), "prompts", "_orchestra-flow.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
})();

const ALL_ROLES: AgentRole[] = ["tech-lead", "designer", "frontend", "backend", "qa", "devops"];

/**
 * Strip the "What you write vs what you signal" section from the shared
 * prelude when building TL's prompt. That section reads "Code / designs →
 * tool calls (Edit, Write, …)" — correct for dev roles, dangerous for TL
 * because it primes the model toward writing files. TL gets the rest of
 * the prelude (tasks, signals, roles, caps, memory) unchanged.
 */
function preludeForRole(role: AgentRole): string {
  if (role !== "tech-lead") return ORCHESTRA_PRELUDE;
  return ORCHESTRA_PRELUDE.replace(
    /\n## What you write vs what you signal[\s\S]*?(?=\n## |\n?$)/,
    "",
  );
}

export function buildAgentDefinitions(opts: {
  pencilEnabled?: boolean;
  /** Limit the returned map to these roles. Defaults to all 6. */
  roles?: AgentRole[];
}): Record<AgentRole, AgentDefinition> {
  const out: Partial<Record<AgentRole, AgentDefinition>> = {};
  const roles = opts.roles ?? ALL_ROLES;
  for (const role of roles) {
    const cfg = agentConfigs[role];
    const md = loadSystemPrompt(role, opts);
    const scope = buildScopeRules(role);
    const prompt = [preludeForRole(role), md, scope].filter(Boolean).join("\n\n---\n\n");
    const def: AgentDefinition = {
      description: ROLE_DESCRIPTIONS[role],
      // Static system prompt = shared orchestra vocabulary + role-specific
      // markdown + scope rules. Dynamic per-task context — task title,
      // pending signals, etc — stays on the per-run user turn.
      prompt,
      // Native tool-name deny. Replaces the manual `toolsDeny` layer in
      // canUseTool. File-path scope (`scope.denied`) is still enforced by
      // canUseTool because the SDK has no native equivalent.
      disallowedTools: cfg.toolsDeny ?? [],
    };
    // Auto-load .claude/agent-memory/<role>/*.md from the worktree at each
    // spawn — useful for dev roles to accumulate per-project conventions.
    // NOT for tech-lead: project memory tends to be implementation-shaped
    // (CLAUDE.md, "the tech stack is X, conventions are Y") and reading
    // it nudges TL away from planning and toward execution.
    if (role !== "tech-lead") def.memory = "project";
    out[role] = def;
  }
  return out as Record<AgentRole, AgentDefinition>;
}
