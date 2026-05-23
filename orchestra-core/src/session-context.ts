import fs from "node:fs";
import path from "node:path";
import { getPool } from "./db";
import { type AgentRole } from "./config";
import { userCanReferenceProject } from "./project-access";
import { notify } from "./notification-hub";
import { log } from "./obs";

export interface ReferenceProject {
  /** Project ID — useful for follow-up tool calls in future phases. */
  id: string;
  slug: string;
  name: string;
  description: string | null;
  /** Absolute path inside the orchestra container the agent can `Read`/`Grep`. */
  absolutePath: string;
  /** First ~500 chars of the project's README, if one exists. */
  readmeExcerpt: string | null;
}

export interface BootstrapContext {
  role: AgentRole;
  projectName: string;
  taskTitle: string | null;
  taskDescription: string | null;
  acceptanceCriteria: string | null;
  pendingSignals: Array<{ from: string; action: string; message?: string }>;
  currentTasks: Array<{ title: string; state: string; assigneeRole: string | null }>;
  lastSummary: string | null;
  /** Other projects the agent may read for context. Empty when none linked. */
  references: ReferenceProject[];
}

export async function buildBootstrapContext(
  projectId: string,
  role: AgentRole,
  taskId?: string,
): Promise<BootstrapContext> {
  const pool = getPool();

  // Project info — owner_id used below to re-check reference-project access.
  const { rows: projRows } = await pool.query(
    "SELECT name, owner_id, settings FROM projects WHERE id = $1",
    [projectId],
  );
  const projectName = projRows[0]?.name ?? "unknown";
  const projectOwnerId = (projRows[0]?.owner_id ?? null) as string | null;
  const projectSettings = (projRows[0]?.settings ?? {}) as { referenceProjects?: unknown };

  // Task info
  let taskTitle: string | null = null;
  let taskDescription: string | null = null;
  const acceptanceCriteria: string | null = null;
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

  // Reference projects: validate the link is still good and load enough
  // metadata for the agent to find its way around. Revocations are silently
  // dropped + a single system message is posted to the chat so the user
  // notices their link is dead (don't fail the whole spawn over it).
  const references = await loadReferenceProjects(projectId, projectOwnerId, projectSettings);

  return {
    role,
    projectName,
    taskTitle,
    taskDescription,
    acceptanceCriteria,
    pendingSignals,
    currentTasks,
    lastSummary,
    references,
  };
}

async function loadReferenceProjects(
  projectId: string,
  projectOwnerId: string | null,
  settings: { referenceProjects?: unknown },
): Promise<ReferenceProject[]> {
  const raw = Array.isArray(settings.referenceProjects) ? settings.referenceProjects : [];
  const refIds = raw.filter((x): x is string => typeof x === "string");
  if (refIds.length === 0 || !projectOwnerId) return [];

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, slug, name, description, local_path
     FROM projects WHERE id = ANY($1::uuid[])`,
    [refIds],
  );
  // Preserve the settings order so the agent sees them as the user listed them.
  const byId = new Map(rows.map((r) => [r.id as string, r]));

  const loaded: ReferenceProject[] = [];
  const dropped: string[] = [];

  for (const refId of refIds) {
    const row = byId.get(refId);
    if (!row) { dropped.push(refId); continue; }
    // Re-check at dispatch time. Catches: owner kicked out of ref project,
    // ref project deleted-and-recreated, manual settings tinkering.
    const ok = await userCanReferenceProject(projectOwnerId, refId);
    if (!ok) { dropped.push(refId); continue; }
    const absolutePath = (row.local_path as string | null) ?? "";
    if (!absolutePath || !fs.existsSync(absolutePath)) {
      // Workspace was wiped or never materialized — link is useless.
      dropped.push(refId);
      continue;
    }
    loaded.push({
      id: row.id as string,
      slug: row.slug as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      absolutePath,
      readmeExcerpt: readReadmeExcerpt(absolutePath),
    });
  }

  if (dropped.length > 0) {
    log.warn({ projectId, dropped }, "reference-projects dropped at bootstrap");
    notify({
      projectId,
      text:
        `⚠ Не удалось подгрузить контекст ${dropped.length} референс-проект(а/ов) ` +
        `(${dropped.join(", ")}) — доступ отозван либо проект удалён. ` +
        `Откройте Настройки проекта → Референсы, чтобы пересмотреть список.`,
      priority: "normal",
      fromRole: "system",
    }).catch(() => { /* best-effort */ });
  }

  if (loaded.length > 0) {
    log.info(
      { projectId, references_loaded: loaded.map((r) => r.slug) },
      "reference projects loaded into bootstrap",
    );
  }

  return loaded;
}

const README_CANDIDATES = ["README.md", "README.markdown", "Readme.md", "readme.md", "README.rst", "README.txt", "README"];
const README_EXCERPT_BYTES = 500;

function readReadmeExcerpt(absolutePath: string): string | null {
  for (const name of README_CANDIDATES) {
    const p = path.join(absolutePath, name);
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) continue;
      // Read up to README_EXCERPT_BYTES — we don't need the whole file for a
      // bootstrap hint; if the agent wants more it can `Read` the file.
      const fd = fs.openSync(p, "r");
      try {
        const buf = Buffer.alloc(README_EXCERPT_BYTES);
        const n = fs.readSync(fd, buf, 0, README_EXCERPT_BYTES, 0);
        return buf.subarray(0, n).toString("utf-8").trim() || null;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Not present or unreadable — try the next candidate name.
    }
  }
  return null;
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

  if (ctx.references.length) {
    lines.push(`## Reference projects (read-only)`);
    lines.push(
      "Inspect these for context only — examples of conventions, prior decisions, " +
      "or code you're being asked to draw from. Use the standard `Read` / `Grep` " +
      "tools against the absolute paths below. **Do not modify any file outside " +
      "your own workspace.**",
    );
    lines.push("");
    for (const r of ctx.references) {
      lines.push(`### ${r.name} — \`${r.absolutePath}\``);
      if (r.description) lines.push(r.description);
      if (r.readmeExcerpt) {
        lines.push("");
        lines.push("README excerpt:");
        lines.push("```");
        lines.push(r.readmeExcerpt);
        lines.push("```");
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
