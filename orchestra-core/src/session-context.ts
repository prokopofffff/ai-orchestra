import { getPool } from "./db.js";
import { type AgentRole } from "./config.js";

export interface BootstrapContext {
  role: AgentRole;
  projectName: string;
  taskTitle: string | null;
  taskDescription: string | null;
  acceptanceCriteria: string | null;
  pendingSignals: Array<{ from: string; action: string; message?: string }>;
  currentTasks: Array<{ title: string; state: string; assigneeRole: string | null }>;
  lastSummary: string | null;
}

export async function buildBootstrapContext(
  projectId: string,
  role: AgentRole,
  taskId?: string,
): Promise<BootstrapContext> {
  const pool = getPool();

  // Project info
  const { rows: projRows } = await pool.query("SELECT name FROM projects WHERE id = $1", [projectId]);
  const projectName = projRows[0]?.name ?? "unknown";

  // Task info
  let taskTitle: string | null = null;
  let taskDescription: string | null = null;
  let acceptanceCriteria: string | null = null;
  if (taskId) {
    const { rows: taskRows } = await pool.query("SELECT title, description FROM tasks WHERE id = $1", [taskId]);
    if (taskRows[0]) {
      taskTitle = taskRows[0].title;
      taskDescription = taskRows[0].description;
    }
  }

  // Pending signals for this role
  const { rows: signalRows } = await pool.query(
    `UPDATE signals SET read = true
     WHERE project_id = $1 AND to_role = $2 AND read = false
     RETURNING from_role, action, payload`,
    [projectId, role],
  );
  const pendingSignals = signalRows.map((r) => ({
    from: r.from_role as string,
    action: r.action as string,
    message: (r.payload as Record<string, unknown>)?.message as string | undefined,
  }));

  // Current project tasks
  const { rows: taskListRows } = await pool.query(
    `SELECT title, state, assignee_role FROM tasks
     WHERE project_id = $1 AND state NOT IN ('merged', 'closed')
     ORDER BY created_at ASC`,
    [projectId],
  );
  const currentTasks = taskListRows.map((r) => ({
    title: r.title as string,
    state: r.state as string,
    assigneeRole: r.assignee_role as string | null,
  }));

  // Read last session summary from task comments or agent logs
  let lastSummary: string | null = null;
  const { rows: summaryRows } = await pool.query(
    `SELECT body FROM task_comments
     WHERE author = $1
     AND task_id IN (SELECT id FROM tasks WHERE project_id = $2)
     ORDER BY created_at DESC LIMIT 1`,
    [role, projectId],
  );
  if (summaryRows[0]) {
    lastSummary = summaryRows[0].body as string;
  }

  return {
    role,
    projectName,
    taskTitle,
    taskDescription,
    acceptanceCriteria,
    pendingSignals,
    currentTasks,
    lastSummary,
  };
}

export function formatBootstrapPrompt(ctx: BootstrapContext): string {
  const lines: string[] = [];

  lines.push(`# Context`);
  lines.push(`You are the **${ctx.role}** agent on project **${ctx.projectName}**.`);
  lines.push("");

  if (ctx.taskTitle) {
    lines.push(`## Current Task`);
    lines.push(`**${ctx.taskTitle}**`);
    if (ctx.taskDescription) lines.push(ctx.taskDescription);
    lines.push("");
  }

  if (ctx.pendingSignals.length) {
    lines.push(`## Pending Signals`);
    for (const s of ctx.pendingSignals) {
      lines.push(`- **${s.from}** → ${s.action}${s.message ? `: ${s.message}` : ""}`);
    }
    lines.push("");
  }

  if (ctx.currentTasks.length) {
    lines.push(`## Project Tasks`);
    for (const t of ctx.currentTasks) {
      lines.push(`- [${t.state}] ${t.title}${t.assigneeRole ? ` (${t.assigneeRole})` : ""}`);
    }
    lines.push("");
  }

  if (ctx.lastSummary) {
    lines.push(`## Previous Session Summary`);
    lines.push(ctx.lastSummary);
    lines.push("");
  }

  return lines.join("\n");
}
