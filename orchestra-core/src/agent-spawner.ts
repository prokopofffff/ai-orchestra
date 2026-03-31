import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SessionManager, AgentRole, AgentRoleSchema } from "./session-manager.js";
import { writeMcpConfig } from "./mcp-config-generator.js";
import { SessionContext } from "./session-context.js";
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

export class AgentSpawner {
  private sessionManager: SessionManager;
  private sessionContext: SessionContext;
  private config: OrchestraConfig;

  constructor(config: OrchestraConfig, sessionManager: SessionManager) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.sessionContext = new SessionContext(config);
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

    let session;
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

    // Launch agent asynchronously
    this.sessionManager
      .launchAgent(session, fullPrompt, workingDir, mcpConfigPath)
      .then((result) => {
        console.log(`Agent ${parsed.role} (${session.id}) completed`);
      })
      .catch((err) => {
        console.error(`Agent ${parsed.role} (${session.id}) failed:`, (err as Error).message);
      });

    return SpawnResultSchema.parse({
      sessionId: session.id,
      status: existing ? "resumed" : "created",
      role: parsed.role,
      projectId: parsed.projectId,
      branch,
    });
  }

  private getProjectDir(projectId: string): string {
    return path.join(PROJECTS_DIR, projectId);
  }

  private ensureProjectDir(dir: string, repoUrl?: string): void {
    const isNew = !existsSync(dir);

    if (isNew) {
      if (repoUrl) {
        console.log(`Cloning ${repoUrl} into ${dir}`);
        execSync(`git clone ${repoUrl} ${dir}`, { stdio: "pipe" });
      } else {
        mkdirSync(dir, { recursive: true });
        execSync("git init", { cwd: dir, stdio: "pipe" });
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
      // Fetch latest from remote
      execSync("git fetch origin", { cwd: workingDir, stdio: "pipe" });
    } catch {
      // No remote configured — skip fetch
    }

    try {
      // Check if branch already exists
      execSync(`git rev-parse --verify ${branch}`, {
        cwd: workingDir,
        stdio: "pipe",
      });
      // Branch exists — checkout
      execSync(`git checkout ${branch}`, { cwd: workingDir, stdio: "pipe" });
      console.log(`Checked out existing branch ${branch}`);
    } catch {
      // Branch doesn't exist — create from main
      const mainBranch = this.getMainBranch(workingDir);
      execSync(`git checkout -b ${branch} ${mainBranch}`, {
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
      const result = execSync(
        "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo refs/heads/main",
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
