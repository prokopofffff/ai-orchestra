import { and, or, eq, exists, sql } from "drizzle-orm";
import { getDb } from "./db";
import { projects, projectMembers, tasks, sessions, signals, taskComments } from "./db/schema";

/**
 * Project access control. A user can see a project iff they own it OR were
 * added as a member. `admin` and `editor` can mutate; `viewer` is read-only.
 *
 * One source of truth so endpoints don't reinvent the join.
 */

export type ProjectRole = "owner" | "admin" | "editor" | "viewer";

/**
 * Returns the role the user has on the project, or null if they have no
 * access at all. Owner takes precedence over any membership row.
 */
export async function getProjectRole(userId: string, projectId: string): Promise<ProjectRole | null> {
  const db = getDb();

  const ownerRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, userId)))
    .limit(1);
  if (ownerRows.length) return "owner";

  const memberRows = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  if (memberRows.length) return (memberRows[0].role as ProjectRole) ?? null;

  return null;
}

export async function userCanAccessProject(userId: string, projectId: string): Promise<boolean> {
  return (await getProjectRole(userId, projectId)) !== null;
}

/**
 * Permission to LINK a project as a context reference from another project.
 * Read access (any membership level) is enough — a viewer can show their
 * project as inspiration material to a project they edit. Distinct from
 * userCanAccessProject only by intent: call this at the call site that
 * checks "can I add this as a referenceProjects entry?" so future tightening
 * (e.g. requiring editor instead of viewer) has one place to change.
 */
export async function userCanReferenceProject(userId: string, projectId: string): Promise<boolean> {
  return userCanAccessProject(userId, projectId);
}

export async function userCanEditProject(userId: string, projectId: string): Promise<boolean> {
  const role = await getProjectRole(userId, projectId);
  return role === "owner" || role === "admin" || role === "editor";
}

export async function userCanAdminProject(userId: string, projectId: string): Promise<boolean> {
  const role = await getProjectRole(userId, projectId);
  return role === "owner" || role === "admin";
}

/**
 * Drizzle predicate: WHERE clause that limits a `projects` query to those
 * visible to the user. Use with `.where(visibilityFilter(userId))`.
 */
export function visibilityFilter(userId: string) {
  return or(
    eq(projects.ownerId, userId),
    exists(
      getDb()
        .select({ one: sql`1` })
        .from(projectMembers)
        .where(and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, userId),
        )),
    ),
  );
}

/**
 * Resource lookup helper: given a child row (task / session / signal) by id,
 * return the project_id, or null if the row doesn't exist.
 */
export async function projectIdOf(
  table: "tasks" | "sessions" | "signals" | "task_comments",
  id: string,
): Promise<string | null> {
  const db = getDb();
  if (table === "tasks") {
    const r = await db.select({ pid: tasks.projectId }).from(tasks).where(eq(tasks.id, id)).limit(1);
    return r[0]?.pid ?? null;
  }
  if (table === "sessions") {
    const r = await db.select({ pid: sessions.projectId }).from(sessions).where(eq(sessions.id, id)).limit(1);
    return r[0]?.pid ?? null;
  }
  if (table === "signals") {
    const r = await db.select({ pid: signals.projectId }).from(signals).where(eq(signals.id, id)).limit(1);
    return r[0]?.pid ?? null;
  }
  // task_comments: hop through tasks
  const r = await db
    .select({ pid: tasks.projectId })
    .from(taskComments)
    .innerJoin(tasks, eq(tasks.id, taskComments.taskId))
    .where(eq(taskComments.id, id))
    .limit(1);
  return r[0]?.pid ?? null;
}

/**
 * IDs of projects this user can see. Handy when filtering child resources
 * (tasks, sessions, signals) — `WHERE project_id = ANY($1)`.
 */
export async function visibleProjectIds(userId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(visibilityFilter(userId));
  return rows.map((r) => r.id);
}
