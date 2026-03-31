import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { AgentRole, AgentRoleSchema } from "./session-manager.js";
import { OrchestraConfig } from "./config.js";

export const SessionSummarySchema = z.object({
  role: AgentRoleSchema,
  projectId: z.string(),
  date: z.string(),
  sessionId: z.string(),
  summary: z.string(),
  decisions: z.string().optional(),
  openQuestions: z.string().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export class SessionContext {
  private pool: Pool;
  private config: OrchestraConfig;

  constructor(config: OrchestraConfig, pool: Pool) {
    this.config = config;
    this.pool = pool;
  }

  /**
   * Build bootstrap prompt for a new or resumed session.
   * Gathers: last session summary + current tasks from OpenProject + pending signals.
   */
  async buildBootstrapContext(
    role: AgentRole,
    projectId: string,
    workingDir: string
  ): Promise<string> {
    const parts: string[] = [];

    // 1. Last session summary
    const lastSummary = this.getLastSummary(role, workingDir);
    if (lastSummary) {
      parts.push("## Контекст из предыдущей сессии\n");
      parts.push(lastSummary);
      parts.push("");
    }

    // 2. Current tasks from OpenProject
    const tasks = await this.fetchOpenProjectTasks(projectId);
    if (tasks) {
      parts.push("## Текущие задачи в OpenProject\n");
      parts.push(tasks);
      parts.push("");
    }

    // 3. Pending signals
    const signals = await this.fetchPendingSignals(role);
    if (signals.length > 0) {
      parts.push("## Непрочитанные сигналы\n");
      for (const sig of signals) {
        parts.push(`- [${sig.from}] ${sig.action}: ${sig.message || "—"}`);
      }
      parts.push("");
    }

    // 4. Design system context for designer role
    if (role === "designer") {
      const styleGuide = this.getDesignStyleGuide(workingDir);
      if (styleGuide) {
        parts.push("## Design System (STYLE.md)\n");
        parts.push(styleGuide);
        parts.push("");
      }
    }

    return parts.join("\n");
  }

  /**
   * Read the most recent session summary for a given role.
   */
  private getLastSummary(role: AgentRole, workingDir: string): string | null {
    const sessionsDir = path.join(workingDir, "docs", "sessions");
    if (!existsSync(sessionsDir)) return null;

    const files = readdirSync(sessionsDir)
      .filter((f) => f.startsWith(role) && f.endsWith(".md"))
      .sort()
      .reverse();

    if (files.length === 0) return null;

    const latestFile = path.join(sessionsDir, files[0]);
    return readFileSync(latestFile, "utf-8");
  }

  /**
   * Fetch current tasks from OpenProject API.
   */
  private async fetchOpenProjectTasks(projectId: string): Promise<string | null> {
    if (!this.config.openproject.apiKey) return null;

    try {
      const response = await fetch(
        `${this.config.openproject.url}/api/v3/projects/${projectId}/work_packages?pageSize=20`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`apikey:${this.config.openproject.apiKey}`).toString("base64")}`,
          },
        }
      );

      if (!response.ok) return null;

      const data = (await response.json()) as {
        _embedded?: {
          elements: Array<{
            id: number;
            subject: string;
            _links?: { status?: { title: string }; type?: { title: string } };
            percentageDone?: number;
          }>;
        };
      };

      const elements = data._embedded?.elements || [];
      if (elements.length === 0) return null;

      return elements
        .map(
          (wp) =>
            `- #${wp.id} [${wp._links?.status?.title || "?"}] ${wp.subject} (${wp.percentageDone || 0}%)`
        )
        .join("\n");
    } catch {
      return null;
    }
  }

  /**
   * Fetch unprocessed signals for an agent role.
   */
  private async fetchPendingSignals(
    role: AgentRole
  ): Promise<Array<{ from: string; action: string; message?: string }>> {
    try {
      // Fetch and mark as processed in one transaction to avoid duplicates
      const result = await this.pool.query(
        `UPDATE signal_queue
         SET processed = TRUE
         WHERE id IN (
           SELECT id FROM signal_queue
           WHERE to_agent = $1 AND processed = FALSE
           ORDER BY created_at ASC
           LIMIT 10
         )
         RETURNING from_agent AS "from", action, context->>'message' AS message`,
        [role]
      );

      return result.rows.map((row) => ({
        from: row.from as string,
        action: row.action as string,
        message: (row.message as string) || undefined,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Read design system STYLE.md for designer context.
   */
  private getDesignStyleGuide(workingDir: string): string | null {
    const stylePath = path.join(workingDir, "designs", "STYLE.md");
    if (!existsSync(stylePath)) return null;
    return readFileSync(stylePath, "utf-8");
  }

  /**
   * Save a session summary file.
   */
  saveSummary(
    role: AgentRole,
    projectId: string,
    sessionId: string,
    workingDir: string,
    content: string
  ): string {
    const sessionsDir = path.join(workingDir, "docs", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    const date = new Date().toISOString().split("T")[0];

    // Find next sequence number for today
    const existing = existsSync(sessionsDir)
      ? readdirSync(sessionsDir).filter(
          (f) => f.startsWith(`${role}-${date}`) && f.endsWith(".md")
        )
      : [];
    const seq = existing.length + 1;

    const fileName = `${role}-${date}-${seq}.md`;
    const filePath = path.join(sessionsDir, fileName);

    const fullContent = [
      "---",
      `role: ${role}`,
      `project: ${projectId}`,
      `date: ${date}`,
      `session_id: ${sessionId}`,
      "---",
      "",
      content,
    ].join("\n");

    writeFileSync(filePath, fullContent);
    return filePath;
  }
}
