import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Pool } from "pg";
import {
  SessionManager,
  AgentRole,
  AgentRoleSchema,
  AgentSession,
} from "./session-manager.js";
import { writeMcpConfig } from "./mcp-config-generator.js";
import { SessionContext } from "./session-context.js";
import { RateLimiter } from "./rate-limiter.js";
import { notifyUser } from "./notify.js";
import { OrchestraConfig } from "./config.js";

export const SpawnAgentInputSchema = z.object({
  role: AgentRoleSchema,
  projectId: z.string().min(1),
  taskId: z.string().optional(),
  prompt: z.string().min(1),
  repoUrl: z.string().optional(),
  branch: z.string().optional(),
  workingDir: z.string().optional(),
});
export type SpawnAgentInput = z.infer<typeof SpawnAgentInputSchema>;

export const SpawnResultSchema = z.object({
  sessionId: z.string(),
  status: z.enum(["resumed", "created"]),
  role: AgentRoleSchema,
  projectId: z.string(),
  branch: z.string().optional(),
});
export type SpawnResult = z.infer<typeof SpawnResultSchema>;

const PROJECTS_DIR = process.env.PROJECTS_DIR || "/projects";
const MAX_RETRIES = parseInt(process.env.AGENT_MAX_RETRIES || "2", 10);

export class AgentSpawner {
  private sessionManager: SessionManager;
  private sessionContext: SessionContext;
  private config: OrchestraConfig;
  private pool: Pool;
  private rateLimiter: RateLimiter | null = null;

  constructor(config: OrchestraConfig, pool: Pool, sessionManager: SessionManager) {
    this.config = config;
    this.pool = pool;
    this.sessionManager = sessionManager;
    this.sessionContext = new SessionContext(config, pool);
  }

  setRateLimiter(rateLimiter: RateLimiter): void {
    this.rateLimiter = rateLimiter;
  }

  async spawn(input: SpawnAgentInput): Promise<SpawnResult> {
    const parsed = SpawnAgentInputSchema.parse(input);
    const workingDir = parsed.workingDir || this.getProjectDir(parsed.projectId);

    // Ensure project directory exists
    this.ensureProjectDir(workingDir, parsed.repoUrl);

    // For per-task dev agents, create a feature branch
    let branch: string | undefined;
    if (this.isPerTaskRole(parsed.role) && parsed.taskId) {
      branch = this.createFeatureBranch(workingDir, parsed.role, parsed.taskId);
    }

    // Generate per-role MCP config
    const mcpConfigDir = path.join(workingDir, ".orchestra");
    mkdirSync(mcpConfigDir, { recursive: true });
    const mcpConfigPath = writeMcpConfig(parsed.role, mcpConfigDir);

    // Build bootstrap context for new sessions
    const bootstrapContext = await this.sessionContext.buildBootstrapContext(
      parsed.role,
      parsed.projectId,
      workingDir
    );

    // Build the full prompt with context
    const fullPrompt = this.buildPrompt(parsed, branch, bootstrapContext);

    // Check for existing session to resume (only for long-lived roles)
    const existing = this.isLongLivedRole(parsed.role)
      ? await this.sessionManager.shouldResume(parsed.role, parsed.projectId)
      : null;

    let session: AgentSession;
    if (existing) {
      session = existing;
      console.log(`Resuming ${parsed.role} session ${session.id}`);
    } else {
      session = await this.sessionManager.createSession(
        parsed.role,
        parsed.projectId,
        parsed.taskId
      );
      console.log(`Created new ${parsed.role} session ${session.id}`);
    }

    // Track launch attempt in DB
    await this.setSessionMeta(session.id, { retryCount: 0, lastError: null });

    // Launch with tracking (not fire-and-forget)
    this.launchWithTracking(session, parsed, fullPrompt, workingDir, mcpConfigPath);

    return SpawnResultSchema.parse({
      sessionId: session.id,
      status: existing ? "resumed" : "created",
      role: parsed.role,
      projectId: parsed.projectId,
      branch,
    });
  }

  /**
   * Launch agent with retry logic, status tracking, and failure notifications.
   * Runs asynchronously but tracks everything in DB.
   */
  private async launchWithTracking(
    session: AgentSession,
    input: SpawnAgentInput,
    prompt: string,
    workingDir: string,
    mcpConfigPath: string
  ): Promise<void> {
    let lastError: string | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(
            `Retry ${attempt}/${MAX_RETRIES} for ${input.role} (${session.id})`
          );
          await this.setSessionMeta(session.id, {
            retryCount: attempt,
            lastError,
          });
        }

        await this.rateLimiter?.incrementActive();

        const result = await this.sessionManager.launchAgent(
          session,
          prompt,
          workingDir,
          mcpConfigPath
        );

        // Success
        await this.rateLimiter?.decrementActive();
        await this.setSessionMeta(session.id, {
          retryCount: attempt,
          lastError: null,
          completedAt: new Date().toISOString(),
          outputLength: result.output.length,
        });

        console.log(
          `Agent ${input.role} (${session.id}) completed successfully (attempt ${attempt + 1})`
        );
        return;
      } catch (err) {
        await this.rateLimiter?.decrementActive();
        lastError = (err as Error).message;

        console.error(
          `Agent ${input.role} (${session.id}) failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${lastError}`
        );

        // Rate limit — don't retry, queue instead
        if (lastError.includes("rate limit") || lastError.includes("429")) {
          await this.rateLimiter?.markRateLimited();
          await this.setSessionMeta(session.id, {
            retryCount: attempt,
            lastError: "rate_limited",
            status: "queued",
          });

          // Re-queue the task
          await this.rateLimiter?.enqueue(input);
          console.log(`Agent ${input.role} (${session.id}) re-queued due to rate limit`);
          return;
        }

        // Last attempt — give up
        if (attempt === MAX_RETRIES) {
          break;
        }

        // Wait before retry (exponential backoff: 5s, 15s)
        const delay = 5000 * Math.pow(3, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // All retries exhausted — mark failed and notify user
    await this.pool.query(
      `UPDATE agent_sessions SET status = 'terminated' WHERE id = $1`,
      [session.id]
    );
    await this.setSessionMeta(session.id, {
      retryCount: MAX_RETRIES,
      lastError,
      status: "failed",
    });

    const errorMsg = [
      `Agent ${input.role} failed after ${MAX_RETRIES + 1} attempts.`,
      `Session: ${session.id}`,
      input.taskId ? `Task: ${input.taskId}` : null,
      `Error: ${lastError}`,
    ]
      .filter(Boolean)
      .join("\n");

    console.error(errorMsg);
    await notifyUser(this.config, `⚠️ ${errorMsg}`);
  }

  private async setSessionMeta(
    sessionId: string,
    meta: Record<string, unknown>
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_meta (session_id, meta)
       VALUES ($1, $2)
       ON CONFLICT (session_id) DO UPDATE SET meta = session_meta.meta || $2`,
      [sessionId, JSON.stringify(meta)]
    );
  }

  private getProjectDir(projectId: string): string {
    return path.join(PROJECTS_DIR, projectId);
  }

  private ensureProjectDir(dir: string, repoUrl?: string): void {
    const isNew = !existsSync(dir);

    if (isNew) {
      if (repoUrl) {
        console.log(`Cloning ${repoUrl} into ${dir}`);
        execFileSync("git", ["clone", repoUrl, dir], { stdio: "pipe" });
      } else {
        mkdirSync(dir, { recursive: true });
        execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
      }
    }

    // Ensure project structure exists
    this.ensureProjectStructure(dir, isNew);
  }

  private ensureProjectStructure(dir: string, isNew: boolean): void {
    const dirs = ["docs", "docs/sessions", "docs/decisions", "designs"];
    for (const d of dirs) {
      mkdirSync(path.join(dir, d), { recursive: true });
    }

    // Copy templates for new projects
    const templatesDir = process.env.TEMPLATES_DIR || "/app/templates";

    if (isNew && existsSync(templatesDir)) {
      // .gitignore
      const gitignoreTemplate = path.join(templatesDir, ".gitignore.template");
      const gitignoreDest = path.join(dir, ".gitignore");
      if (existsSync(gitignoreTemplate) && !existsSync(gitignoreDest)) {
        copyFileSync(gitignoreTemplate, gitignoreDest);
      }

      // CLAUDE.md
      const claudeTemplate = path.join(templatesDir, "CLAUDE.md.template");
      const claudeDest = path.join(dir, "CLAUDE.md");
      if (existsSync(claudeTemplate) && !existsSync(claudeDest)) {
        const projectName = path.basename(dir);
        let content = readFileSync(claudeTemplate, "utf-8");
        content = content.replace(/\{\{PROJECT_NAME\}\}/g, projectName);
        content = content.replace(/\{\{PROJECT_DESCRIPTION\}\}/g, "");
        writeFileSync(claudeDest, content);
      }
    }
  }

  private createFeatureBranch(
    workingDir: string,
    role: AgentRole,
    taskId: string
  ): string {
    const branchPrefix = this.getBranchPrefix(role);
    const branch = `${branchPrefix}/${taskId}`;

    try {
      execFileSync("git", ["fetch", "origin"], { cwd: workingDir, stdio: "pipe" });
    } catch {
      // No remote configured — skip fetch
    }

    try {
      execFileSync("git", ["rev-parse", "--verify", branch], {
        cwd: workingDir,
        stdio: "pipe",
      });
      execFileSync("git", ["checkout", branch], { cwd: workingDir, stdio: "pipe" });
      console.log(`Checked out existing branch ${branch}`);
    } catch {
      const mainBranch = this.getMainBranch(workingDir);
      execFileSync("git", ["checkout", "-b", branch, mainBranch], {
        cwd: workingDir,
        stdio: "pipe",
      });
      console.log(`Created new branch ${branch} from ${mainBranch}`);
    }

    return branch;
  }

  private getBranchPrefix(role: AgentRole): string {
    const prefixes: Record<AgentRole, string> = {
      "tech-lead": "tech-lead",
      designer: "design",
      frontend: "feature/frontend",
      backend: "feature/backend",
      qa: "test",
      devops: "devops",
    };
    return prefixes[role];
  }

  private getMainBranch(workingDir: string): string {
    try {
      const result = execFileSync(
        "git",
        ["symbolic-ref", "refs/remotes/origin/HEAD"],
        { cwd: workingDir, encoding: "utf-8" }
      ).trim();
      return result.replace("refs/remotes/origin/", "").replace("refs/heads/", "");
    } catch {
      return "main";
    }
  }

  private buildPrompt(
    input: SpawnAgentInput,
    branch?: string,
    bootstrapContext?: string
  ): string {
    const parts: string[] = [];

    if (bootstrapContext) {
      parts.push(bootstrapContext);
      parts.push("---\n");
    }

    if (branch) {
      parts.push(`Ты работаешь в ветке: ${branch}`);
    }

    if (input.taskId) {
      parts.push(`Task ID: ${input.taskId}`);
      parts.push(`Прочитай задачу из OpenProject: openproject_get_task(${input.taskId})`);
    }

    parts.push("");
    parts.push(input.prompt);

    return parts.join("\n");
  }

  private isPerTaskRole(role: AgentRole): boolean {
    return ["frontend", "backend", "qa", "devops", "designer"].includes(role);
  }

  private isLongLivedRole(role: AgentRole): boolean {
    return role === "tech-lead";
  }
}
