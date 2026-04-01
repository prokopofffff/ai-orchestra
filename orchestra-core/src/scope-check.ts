import { type AgentRole } from "./config.js";

// ─── Scope rules per role ───

interface ScopeRule {
  allowed: string[];
  denied: string[];
}

const scopeRules: Record<AgentRole, ScopeRule> = {
  "tech-lead": { allowed: ["**/*"], denied: [] },
  designer: { allowed: ["design/**", "**/*.pen", "STYLE.md"], denied: ["src/**"] },
  frontend: {
    allowed: ["src/frontend/**", "src/shared/types/**", "public/**"],
    denied: ["src/backend/**", "src/api/**", "database/**"],
  },
  backend: {
    allowed: ["src/backend/**", "src/api/**", "database/**", "src/shared/types/**"],
    denied: ["src/frontend/**", "public/**"],
  },
  qa: { allowed: ["tests/**", "e2e/**"], denied: [] },
  devops: { allowed: [".github/**", "docker-compose.yml", "Dockerfile", "ci/**"], denied: [] },
};

// ─── Glob matching (simple) ───

function matchGlob(pattern: string, filePath: string): boolean {
  if (pattern === "**/*") return true;

  // Convert glob to regex
  const regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "___DOUBLESTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___DOUBLESTAR___/g, ".*");

  return new RegExp(`^${regexStr}$`).test(filePath);
}

function matchesAny(patterns: string[], filePath: string): boolean {
  return patterns.some((p) => matchGlob(p, filePath));
}

// ─── Check a single file ───

export interface ScopeViolation {
  file: string;
  reason: "denied" | "not_allowed";
  pattern?: string;
}

export function checkFileScope(role: AgentRole, filePath: string): ScopeViolation | null {
  const rules = scopeRules[role];
  if (!rules) return { file: filePath, reason: "not_allowed" };

  // Check denied first
  for (const pattern of rules.denied) {
    if (matchGlob(pattern, filePath)) {
      return { file: filePath, reason: "denied", pattern };
    }
  }

  // Check allowed
  if (!matchesAny(rules.allowed, filePath)) {
    return { file: filePath, reason: "not_allowed" };
  }

  return null; // OK
}

// ─── Check multiple files (e.g., from a PR diff) ───

export function checkFilesScope(role: AgentRole, files: string[]): ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  for (const file of files) {
    const v = checkFileScope(role, file);
    if (v) violations.push(v);
  }
  return violations;
}

// ─── Format violations for review feedback ───

export function formatViolations(role: AgentRole, violations: ScopeViolation[]): string {
  if (!violations.length) return "";

  const lines = [`Scope violations for ${role}:`];
  for (const v of violations) {
    if (v.reason === "denied") {
      lines.push(`  - ${v.file} — in denied path (${v.pattern})`);
    } else {
      lines.push(`  - ${v.file} — outside allowed scope`);
    }
  }
  return lines.join("\n");
}

export function getScopeRules(role: AgentRole): ScopeRule {
  return scopeRules[role];
}
