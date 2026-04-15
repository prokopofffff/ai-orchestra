import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { minimatch } from "minimatch";
import { registerHandler } from "../scheduler";
import { appendLog } from "../logger";
import { getPool } from "../db";
import { logBackgroundError } from "../error-handler";
import { resolveChecks } from "./configs";
import type { AgentRole } from "../config";

const execAsync = promisify(exec);

export const CHECK_KIND = "agent:observe-check";

const ChecksPayload = z.object({
  projectId: z.string(),
  sessionId: z.string().nullable(),
  taskId: z.string().nullable(),
  role: z.enum(["tech-lead", "designer", "frontend", "backend", "qa", "devops"]),
  worktree: z.string(),
  filePath: z.string(),
});

registerHandler(CHECK_KIND, ChecksPayload, async (p, ctx) => {
  const { rows } = await getPool().query(
    "SELECT settings FROM projects WHERE id = $1",
    [p.projectId],
  );
  const checks = resolveChecks(p.role as AgentRole, rows[0]?.settings);
  if (checks.length === 0) return;

  // File path may be absolute (from Claude tool input) — make it relative
  // to the worktree for glob matching.
  const rel = p.filePath.startsWith(p.worktree)
    ? p.filePath.slice(p.worktree.length).replace(/^\//, "")
    : p.filePath;

  const applicable = checks.filter((c) => minimatch(rel, c.pattern));
  if (applicable.length === 0) return;

  for (const check of applicable) {
    await ctx.extendLease(); // checks can be slow
    const start = Date.now();
    let success = true;
    let stdout: string;
    let stderr: string;

    try {
      const result = await execAsync(check.command, {
        cwd: p.worktree,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err) {
      success = false;
      const e = err as { stdout?: string; stderr?: string; message?: string };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? e.message ?? "";
    }

    const ms = Date.now() - start;
    const summary = success
      ? `[check:${check.name}] PASS (${ms}ms) ${rel}`
      : `[check:${check.name}] FAIL (${ms}ms) ${rel}\n${tail(stderr || stdout, 800)}`;

    appendLog(p.projectId, p.sessionId, p.role, success ? "system" : "error", summary);

    if (!success && check.onFail === "alert") {
      await alertTechLead(p.projectId, p.taskId, p.role, check.name, rel, stderr || stdout);
    }
  }
});

async function alertTechLead(
  projectId: string,
  taskId: string | null,
  role: string,
  checkName: string,
  file: string,
  detail: string,
): Promise<void> {
  const message = `[${role}] ${checkName} failed on ${file}\n${tail(detail, 400)}`;
  await getPool().query(
    `INSERT INTO signals (project_id, task_id, from_role, to_role, action, payload)
     VALUES ($1, $2, 'system', 'tech-lead', 'notify', $3)`,
    [projectId, taskId, JSON.stringify({ message, source: "observe-hook" })],
  ).catch((e) => logBackgroundError("observe-hook:alert", e, projectId));
}

function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return "…" + s.slice(s.length - max);
}
