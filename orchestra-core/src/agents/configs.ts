import type { AgentRole } from "../config";
import type { AgentConfig } from "./types";

// ─── Shared base permissions ───
//
// Every agent gets the basic read/write/edit/grep/glob plus safe bash subsets.
// Roles add or deny on top.

const BASE_ALLOW = [
  "Read", "Edit", "Write", "Glob", "Grep",
  "Bash(git:*)", "Bash(pnpm:*)", "Bash(node:*)", "Bash(npx:*)",
  "WebFetch",
];

const BASE_DENY = [
  "Bash(rm:-rf*)",
  "Bash(sudo:*)",
  "Bash(curl:*--data*)",   // block POST/PUT via curl, allow GETs
];

// ─── Per-role configs ───

export const agentConfigs: Record<AgentRole, AgentConfig> = {
  "tech-lead": {
    role: "tech-lead",
    promptFile: "tech-lead",
    // TL is a planner: it reads code, talks to the user, and delegates.
    // It must NOT modify files, run lint/test, or touch design tooling —
    // each of those is some specialist's responsibility. The deny list
    // is the enforcement; the system prompt explains the why.
    scope: { allowed: ["**/*"], denied: [] },
    permissions: { allow: BASE_ALLOW, deny: BASE_DENY },
    toolsDeny: [
      // No file writes — TL is a planner, not an implementer.
      "Edit", "Write", "MultiEdit", "NotebookEdit",
      // No shell — TL can Read/Glob/Grep files to understand the codebase.
      // Bash would let it scaffold projects (mkdir, touch, curl …) which is
      // exactly the failure we keep seeing: instead of writing tasks, TL
      // does the work itself.
      "Bash",
      // No subagent spawning. Orchestra has its own delegation flow via
      // the signal-tool MCP. The SDK exposes the same capability under
      // *both* "Task" and "Agent" depending on plugin/version — block
      // both. (Observed: TL invoked [tool:Agent] then the subagent
      // spawned Bash/Write outside our canUseTool scope.)
      "Task", "Agent",
      // ToolSearch is the SDK's deferred-tool loader. With Bash/Edit/etc
      // disallowed, TL noticed they were missing and started spamming
      // ToolSearch calls trying to re-discover their schemas. Schemas
      // wouldn't help (the calls would still be denied) but it burns
      // budget and confuses the chat log. Just remove the search.
      "ToolSearch",
      // TL has no business using Claude Code's internal todo list —
      // orchestra has its own task system via the task-tool MCP. Having
      // both around makes the model bounce between them.
      "TodoWrite",
      // Plan-mode is a Claude Code UX concept for the CLI; we're driving
      // a non-interactive run and don't read plan-mode state. Letting TL
      // toggle it just produces noise like [tool:EnterPlanMode].
      "EnterPlanMode", "ExitPlanMode",
      // AskUserQuestion routes through the CLI's interactive prompt UI.
      // In our runtime there's no operator at the other end — TL should
      // ask the user via its normal chat reply, not a separate tool.
      "AskUserQuestion",
      // The pencil MCP is loaded globally (Claude Code plugin) — it's the
      // designer's surface. TL writing designs directly bypasses the flow.
      "mcp__pencil__*",
    ],
    checks: [],
  },

  designer: {
    role: "designer",
    promptFile: "designer",
    fallbackPromptFile: "designer-no-pencil",
    scope: { allowed: ["design/**", "**/*.pen", "STYLE.md"], denied: ["src/**"] },
    permissions: {
      allow: [...BASE_ALLOW, "mcp__pencil"],
      deny: [...BASE_DENY, "Edit(src/**)", "Write(src/**)"],
    },
    checks: [],
  },

  frontend: {
    role: "frontend",
    promptFile: "dev-frontend",
    scope: {
      allowed: ["src/frontend/**", "src/shared/types/**", "public/**"],
      denied: ["src/backend/**", "src/api/**", "database/**"],
    },
    permissions: {
      allow: BASE_ALLOW,
      deny: [...BASE_DENY, "Edit(src/backend/**)", "Edit(database/**)", "Write(src/backend/**)"],
    },
    checks: [
      {
        name: "tsc",
        pattern: "src/frontend/**/*.{ts,tsx}",
        command: "pnpm exec tsc --noEmit",
        onFail: "warn",
      },
      {
        name: "eslint",
        pattern: "src/frontend/**/*.{ts,tsx}",
        command: "pnpm exec eslint --max-warnings=0",
        onFail: "warn",
      },
    ],
  },

  backend: {
    role: "backend",
    promptFile: "dev-backend",
    scope: {
      allowed: ["src/backend/**", "src/api/**", "database/**", "src/shared/types/**"],
      denied: ["src/frontend/**", "public/**"],
    },
    permissions: {
      allow: BASE_ALLOW,
      deny: [...BASE_DENY, "Edit(src/frontend/**)", "Edit(public/**)", "Write(src/frontend/**)"],
    },
    checks: [
      {
        name: "tsc",
        pattern: "src/backend/**/*.ts",
        command: "pnpm exec tsc --noEmit",
        onFail: "warn",
      },
      {
        name: "eslint",
        pattern: "src/backend/**/*.ts",
        command: "pnpm exec eslint --max-warnings=0",
        onFail: "warn",
      },
    ],
  },

  qa: {
    role: "qa",
    promptFile: "qa",
    scope: {
      allowed: ["tests/**", "e2e/**", "**/*.config.*", "**/*.test.*", "**/*.spec.*", "package.json"],
      denied: [],
    },
    permissions: { allow: BASE_ALLOW, deny: BASE_DENY },
    checks: [
      {
        name: "tsc",
        pattern: "**/*.{ts,tsx}",
        command: "pnpm exec tsc --noEmit",
        onFail: "warn",
      },
      {
        name: "vitest",
        // Run only the touched test file's package — adjust per project.
        pattern: "**/*.{test,spec}.{ts,tsx}",
        command: "pnpm exec vitest run --reporter=basic",
        onFail: "alert",
      },
    ],
  },

  devops: {
    role: "devops",
    promptFile: "devops",
    scope: { allowed: [".github/**", "docker-compose.yml", "Dockerfile", "ci/**"], denied: [] },
    permissions: { allow: [...BASE_ALLOW, "Bash(docker:*)"], deny: BASE_DENY },
    checks: [],
  },
};

export function getAgentConfig(role: AgentRole): AgentConfig {
  return agentConfigs[role];
}

/**
 * Resolve the effective check list for (role, project). A project's
 * `settings.checks[role]` (if present) replaces the role default for THAT role.
 * Pass `null` settings to get the role default.
 */
export function resolveChecks(
  role: AgentRole,
  projectSettings: unknown,
): import("./types").AgentCheck[] {
  const settings = projectSettings as { checks?: Record<string, import("./types").AgentCheck[]> } | null | undefined;
  const override = settings?.checks?.[role];
  if (Array.isArray(override)) return override;
  return agentConfigs[role].checks;
}
