import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { installScopeHook } from "../scope-enforcer";

const tempDirs: string[] = [];

function makeWorktree(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "scope-enforcer-"));
  fs.mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  // nothing — each test makes its own worktree
});

afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("scope-enforcer — installScopeHook", () => {
  it("skips tech-lead (no scope restrictions)", () => {
    const dir = makeWorktree();
    installScopeHook(dir, "tech-lead");
    const hookPath = path.join(dir, ".git", "hooks", "pre-commit");
    expect(fs.existsSync(hookPath)).toBe(false);
  });

  it("writes an executable pre-commit hook for scoped roles", () => {
    const dir = makeWorktree();
    installScopeHook(dir, "backend");
    const hookPath = path.join(dir, ".git", "hooks", "pre-commit");
    expect(fs.existsSync(hookPath)).toBe(true);
    const mode = fs.statSync(hookPath).mode & 0o777;
    // At minimum the owner-execute bit should be set
    expect(mode & 0o100).toBeTruthy();
  });

  it("hook body mentions the role and the allowed/denied patterns from configs", () => {
    const dir = makeWorktree();
    installScopeHook(dir, "backend");
    const body = fs.readFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "utf-8");
    expect(body).toMatch(/role: backend/);
    expect(body).toContain("src/backend/**");
    expect(body).toContain("src/frontend/**"); // in backend's denied list
    expect(body).toContain("git diff --cached");
  });

  it("hook body escapes glob dots when converting to grep patterns", () => {
    const dir = makeWorktree();
    installScopeHook(dir, "devops"); // allowed includes "docker-compose.yml"
    const body = fs.readFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "utf-8");
    // Dot should be escaped to \. in the grep pattern
    expect(body).toMatch(/docker-compose\\\.yml/);
  });

  it("follows worktree .git redirect (.git as a file, not a dir)", () => {
    const dir = makeWorktree();
    // Replace the .git dir with a file pointing at a sibling — simulates `git worktree add`
    fs.rmSync(path.join(dir, ".git"), { recursive: true });
    const realGitDir = path.join(dir, "..real-git");
    fs.mkdirSync(path.join(realGitDir, "hooks"), { recursive: true });
    tempDirs.push(realGitDir);
    fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${realGitDir}`);

    installScopeHook(dir, "qa");
    // Hook should land in the real hooks dir, NOT in the worktree's (non-existent) .git/hooks
    expect(fs.existsSync(path.join(realGitDir, "hooks", "pre-commit"))).toBe(true);
  });

  it("allowed + denied patterns from the hook are specific to the role", () => {
    const dir1 = makeWorktree();
    const dir2 = makeWorktree();
    installScopeHook(dir1, "frontend");
    installScopeHook(dir2, "qa");

    const fe = fs.readFileSync(path.join(dir1, ".git", "hooks", "pre-commit"), "utf-8");
    const qa = fs.readFileSync(path.join(dir2, ".git", "hooks", "pre-commit"), "utf-8");

    expect(fe).toContain("src/frontend/**");
    expect(fe).not.toContain("tests/**");
    expect(qa).toContain("tests/**");
    expect(qa).not.toContain("src/frontend/**");
  });
});
