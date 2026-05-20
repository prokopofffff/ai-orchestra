import type { AgentRole } from "../../config";
import { agentConfigs } from "../configs";
import { buildAgentDefinitions } from "../role-definitions";
import type { AgentRunInput } from "./types";

/**
 * Per-worktree settings.json passed to `claude -p --settings <json>`.
 *
 * Three jobs:
 *   1. **`sandbox`** — kernel-enforced filesystem confinement (Seatbelt on
 *      macOS, bubblewrap on Linux). Closes the path-escape gap the old
 *      canUseTool's Bash-command scanner used to enforce: an agent that
 *      asks for `cat /etc/passwd` is now denied by the OS, not by our
 *      regex. allowWrite/allowRead include the worktree only; everything
 *      else is denied by default.
 *
 *   2. **`permissions.allow` / `permissions.deny`** — application-level
 *      matchers (`Read`, `Bash(git:*)`, `Edit(src/**)`). The CLI strips
 *      denied tools from the model's tool set before generation. Layered
 *      on top of the kernel sandbox: defense in depth, plus useful for
 *      path-glob scope (per-role denied directories) that the OS can't
 *      easily express.
 *
 *   3. **Hooks intentionally omitted.** The old sdk-runner enqueued an
 *      observe-check job from a PostToolUse hook closure. With the CLI we
 *      watch `tool_use` events directly in the JSON stream and enqueue
 *      from the runtime — one less moving piece in the worktree.
 */
export type ClaudeSettingsJson = {
  sandbox?: {
    enabled: boolean;
    filesystem?: {
      allowWrite?: string[];
      allowRead?: string[];
      denyWrite?: string[];
      denyRead?: string[];
    };
  };
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
};

export function buildClaudeSettings(input: {
  role: AgentRole;
  cwd: string;
  /**
   * Whether to enable the OS sandbox. False during the rollout window where
   * we want the CLI to behave like the SDK did (no kernel confinement).
   * Default true.
   */
  sandbox?: boolean;
}): ClaudeSettingsJson {
  const cfg = agentConfigs[input.role];
  const settings: ClaudeSettingsJson = {
    permissions: {
      allow: cfg.permissions.allow,
      deny: [
        ...cfg.permissions.deny,
        // Per-role file-path scope expressed as Edit/Write/MultiEdit denies.
        // The OS sandbox covers reads; this catches writes that the model
        // tries to land outside its role's directory tree.
        ...cfg.scope.denied.flatMap((glob) => [
          `Edit(${glob})`,
          `Write(${glob})`,
          `MultiEdit(${glob})`,
        ]),
      ],
    },
  };
  if (input.sandbox !== false) {
    settings.sandbox = {
      enabled: true,
      filesystem: {
        // Worktree only. Agents that need extra dirs (e.g. designer reading
        // a shared style guide) get them added via --add-dir at spawn time.
        allowWrite: [input.cwd],
        allowRead: [input.cwd],
      },
    };
  }
  return settings;
}

/**
 * CLI argv for one agent run. Caller spawns `claude` with `{ cwd: input.cwd,
 * env: { ...process.env, ANTHROPIC_API_KEY: ... }, stdio: ['ignore', 'pipe',
 * 'pipe'] }` and pipes the prompt via stdin or passes it as the final
 * positional argument.
 *
 * The prompt itself is NOT in the args — it goes via stdin to avoid argv
 * length limits and to keep secret-ish content out of process listings.
 */
export function buildClaudeCliArgs(input: {
  role: AgentRole;
  model: string;
  effort?: "low" | "medium" | "high" | "max";
  sessionId: string;
  resumeSessionId?: string;
  maxBudgetUsd: number;
  pencilEnabled?: boolean;
  mcpServers: AgentRunInput["mcpServers"];
  /** True → emit `--bare` (API-key mode, skips keychain/plugin overhead). */
  bare: boolean;
}): { argv: string[]; stdinPrompt: string | null } {
  const cfg = agentConfigs[input.role];
  const agentsJson = JSON.stringify(
    buildAgentDefinitions({
      pencilEnabled: input.pencilEnabled,
      // Match the old TL path: TL gets ONLY its own definition. Bundling all
      // six roles makes the model list them as Task/Agent subagent targets,
      // and TL tries to delegate via `Task`, hits the deny, deny-streak
      // aborts. Orchestra delegates via signal-tool MCP, not subagents.
      roles: input.role === "tech-lead" ? ["tech-lead"] : undefined,
    }),
  );

  const mcpJson = JSON.stringify({
    mcpServers: Object.fromEntries(
      Object.entries(input.mcpServers).map(([name, s]) => [
        name,
        { command: s.command, args: s.args, env: s.env ?? {} },
      ]),
    ),
  });

  const argv: string[] = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    // `--include-partial-messages` would surface mid-turn deltas; we
    // currently buffer full assistant turns and don't want partial noise.
    "--input-format", "text",
    // `bypassPermissions` skips the interactive approval prompt — required
    // for headless `--print` mode, otherwise the CLI auto-denies every tool
    // call (there's no human to say yes). Safety still comes from four
    // layers: `--disallowedTools` strips denied tools from the model's
    // visible tool set entirely; `permissions.deny` in settings.json
    // enforces glob-based denies; the OS sandbox (Seatbelt/bubblewrap)
    // confines filesystem ops; and the git scope hook catches out-of-scope
    // writes at commit time. `bypassPermissions` only bypasses the prompt,
    // not the deny list — so denied tools still get rejected by the CLI.
    "--permission-mode", "bypassPermissions",
    "--model", input.model,
    "--session-id", input.sessionId,
    "--max-budget-usd", String(input.maxBudgetUsd),
    "--agent", input.role,
    "--agents", agentsJson,
    "--mcp-config", mcpJson,
    "--strict-mcp-config", // ignore any host-level .mcp.json
    "--disallowedTools", (cfg.toolsDeny ?? []).join(","),
  ];

  if (input.effort) argv.push("--effort", input.effort);
  if (input.resumeSessionId) argv.push("--resume", input.resumeSessionId);
  if (input.bare) argv.push("--bare");

  return { argv, stdinPrompt: null };
}
