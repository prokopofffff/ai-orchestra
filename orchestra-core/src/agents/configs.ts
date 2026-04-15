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
    scope: { allowed: ["**/*"], denied: [] },
    permissions: { allow: BASE_ALLOW, deny: BASE_DENY },
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
