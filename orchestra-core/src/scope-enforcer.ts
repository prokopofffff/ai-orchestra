import fs from "node:fs";
import path from "node:path";
import { type AgentRole } from "./config";
import { getScopeRules } from "./scope-check";

/**
 * Install a git pre-commit hook in the worktree that enforces scope rules.
 * This is a hard boundary — the agent physically cannot commit out-of-scope files.
 */
export function installScopeHook(worktreeDir: string, role: AgentRole): void {
  if (role === "tech-lead") return; // Tech Lead has full access

  const rules = getScopeRules(role);
  const hookDir = path.join(worktreeDir, ".git", "hooks");

  // .git in worktrees is a file pointing to the real .git dir
  const gitFile = path.join(worktreeDir, ".git");
  let realHookDir = hookDir;
  if (fs.existsSync(gitFile) && fs.statSync(gitFile).isFile()) {
    const content = fs.readFileSync(gitFile, "utf-8").trim();
    // "gitdir: /path/to/.git/worktrees/branch-name"
    const gitdir = content.replace("gitdir: ", "");
    realHookDir = path.join(gitdir, "hooks");
  }

  fs.mkdirSync(realHookDir, { recursive: true });

  const hookScript = generatePreCommitHook(role, rules.allowed, rules.denied);
  const hookPath = path.join(realHookDir, "pre-commit");
  fs.writeFileSync(hookPath, hookScript, { mode: 0o755 });
}

function generatePreCommitHook(
  role: string,
  allowed: string[],
  denied: string[],
): string {
  // Generate a bash script that checks staged files against scope rules
  // Uses git's own globbing via grep patterns
  const allowPatterns = allowed.map(globToGrepPattern).filter(Boolean);
  const denyPatterns = denied.map(globToGrepPattern).filter(Boolean);

  return `#!/bin/bash
# Auto-generated scope enforcement hook for role: ${role}
# This hook prevents committing files outside the agent's allowed scope.

STAGED=$(git diff --cached --name-only --diff-filter=ACMR)
if [ -z "$STAGED" ]; then
  exit 0
fi

VIOLATIONS=""

while IFS= read -r file; do
  # Skip empty lines
  [ -z "$file" ] && continue

  # Check denied patterns first
  DENIED=0
${denyPatterns.map((p) => `  if echo "$file" | grep -qE '${p}'; then DENIED=1; fi`).join("\n")}

  if [ "$DENIED" = "1" ]; then
    VIOLATIONS="$VIOLATIONS\\n  DENIED: $file"
    continue
  fi

  # Check if file matches any allowed pattern
  ALLOWED=0
${allowPatterns.map((p) => `  if echo "$file" | grep -qE '${p}'; then ALLOWED=1; fi`).join("\n")}

  if [ "$ALLOWED" = "0" ]; then
    VIOLATIONS="$VIOLATIONS\\n  NOT ALLOWED: $file"
  fi
done <<< "$STAGED"

if [ -n "$VIOLATIONS" ]; then
  echo ""
  echo "SCOPE VIOLATION — role '${role}' cannot modify these files:"
  echo -e "$VIOLATIONS"
  echo ""
  echo "Allowed paths: ${allowed.join(", ")}"
  ${denied.length ? `echo "Denied paths: ${denied.join(", ")}"` : ""}
  echo ""
  echo "Unstage out-of-scope files with: git reset HEAD <file>"
  exit 1
fi

exit 0
`;
}

/**
 * Convert a glob pattern to a grep -E regex.
 */
function globToGrepPattern(glob: string): string {
  if (glob === "**/*") return ""; // matches everything, skip

  return glob
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "___DOUBLE___")
    .replace(/\*/g, "[^/]*")
    .replace(/___DOUBLE___/g, ".*");
}
