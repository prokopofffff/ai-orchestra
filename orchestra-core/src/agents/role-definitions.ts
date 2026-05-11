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

export function buildAgentDefinitions(opts: { pencilEnabled?: boolean }): Record<AgentRole, AgentDefinition> {
  const out: Partial<Record<AgentRole, AgentDefinition>> = {};
  const roles: AgentRole[] = ["tech-lead", "designer", "frontend", "backend", "qa", "devops"];
  for (const role of roles) {
    const cfg = agentConfigs[role];
    const md = loadSystemPrompt(role, opts);
    const scope = buildScopeRules(role);
    const prompt = [ORCHESTRA_PRELUDE, md, scope].filter(Boolean).join("\n\n---\n\n");
    out[role] = {
      description: ROLE_DESCRIPTIONS[role],
      // Static system prompt = shared orchestra vocabulary + role-specific
      // markdown + scope rules. Dynamic per-task context — task title,
      // pending signals, etc — stays on the per-run user turn.
      prompt,
      // Native tool-name deny. Replaces the manual `toolsDeny` layer in
      // canUseTool. File-path scope (`scope.denied`) is still enforced by
      // canUseTool because the SDK has no native equivalent.
      disallowedTools: cfg.toolsDeny ?? [],
      // Auto-load .claude/agent-memory/<role>/*.md from the worktree at
      // each spawn. Gives each role a place to accumulate per-project
      // notes (conventions, weird gotchas, prior decisions) without us
      // having to plumb a DB-backed memory store. Roles can read and
      // write these files themselves over time.
      memory: "project",
    };
  }
  return out as Record<AgentRole, AgentDefinition>;
}
