import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { projectMembers, users, projects } from "./db/schema";
import { currentUserId } from "./auth";
import { userCanAdminProject, userCanAccessProject, getProjectRole } from "./project-access";

const inviteSchema = z.object({
  identifier: z.string().min(1), // email or username
  role: z.enum(["viewer", "editor", "admin"]).default("editor"),
});

const roleSchema = z.object({
  role: z.enum(["viewer", "editor", "admin"]),
});

/**
 * Project membership management. Owner + admins can list / invite / remove
 * members. Plain members (editor / viewer) can only see the list.
 */
export const membersPlugin: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>("/projects/:id/members", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.params.id;
    if (!(await userCanAccessProject(userId, projectId))) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const db = getDb();
    const [proj] = await db
      .select({ ownerId: projects.ownerId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!proj) return reply.code(404).send({ error: "Project not found" });

    // Members + their basic user info. Owner returned alongside as a
    // synthetic role="owner" entry so the UI doesn't need a second fetch.
    const memberRows = await db
      .select({
        userId: projectMembers.userId,
        role: projectMembers.role,
        addedAt: projectMembers.addedAt,
        email: users.email,
        username: users.username,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId));

    let owner: { userId: string; email: string; username: string; role: "owner" } | null = null;
    if (proj.ownerId) {
      const [u] = await db
        .select({ id: users.id, email: users.email, username: users.username })
        .from(users)
        .where(eq(users.id, proj.ownerId))
        .limit(1);
      if (u) owner = { userId: u.id, email: u.email, username: u.username, role: "owner" };
    }

    return {
      owner,
      members: memberRows.map((m) => ({
        userId: m.userId,
        email: m.email,
        username: m.username,
        role: m.role as "viewer" | "editor" | "admin",
        addedAt: m.addedAt,
      })),
    };
  });

  app.post<{ Params: { id: string } }>("/projects/:id/members", async (request, reply) => {
    const userId = currentUserId(request);
    const projectId = request.params.id;
    if (!(await userCanAdminProject(userId, projectId))) {
      return reply.code(403).send({ error: "Only project owner/admin can invite" });
    }
    const body = inviteSchema.parse(request.body);
    const ident = body.identifier.trim().toLowerCase();
    const db = getDb();

    const [target] = await db
      .select({ id: users.id, email: users.email, username: users.username })
      .from(users)
      .where(sql`lower(${users.email}) = ${ident} OR lower(${users.username}) = ${ident}`)
      .limit(1);
    if (!target) return reply.code(404).send({ error: "User not found" });

    // Don't add the owner as a member — they already have full access via
    // owner_id, a member row would be a no-op duplicate of state.
    const role = await getProjectRole(target.id, projectId);
    if (role === "owner") {
      return reply.code(400).send({ error: "User is already the project owner" });
    }

    await db
      .insert(projectMembers)
      .values({ projectId, userId: target.id, role: body.role })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role: body.role },
      });

    return reply.code(201).send({
      userId: target.id,
      email: target.email,
      username: target.username,
      role: body.role,
    });
  });

  app.patch<{ Params: { id: string; userId: string } }>("/projects/:id/members/:userId", async (request, reply) => {
    const callerId = currentUserId(request);
    const projectId = request.params.id;
    if (!(await userCanAdminProject(callerId, projectId))) {
      return reply.code(403).send({ error: "Only project owner/admin can change roles" });
    }
    const body = roleSchema.parse(request.body);
    const db = getDb();
    const [row] = await db
      .update(projectMembers)
      .set({ role: body.role })
      .where(and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, request.params.userId),
      ))
      .returning();
    if (!row) return reply.code(404).send({ error: "Membership not found" });
    return row;
  });

  app.delete<{ Params: { id: string; userId: string } }>("/projects/:id/members/:userId", async (request, reply) => {
    const callerId = currentUserId(request);
    const projectId = request.params.id;
    const targetUserId = request.params.userId;

    // Self-removal is fine: any member can leave a project. Otherwise admin only.
    if (callerId !== targetUserId && !(await userCanAdminProject(callerId, projectId))) {
      return reply.code(403).send({ error: "Only project owner/admin can remove members" });
    }
    const db = getDb();
    const r = await db
      .delete(projectMembers)
      .where(and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, targetUserId),
      ));
    if (!(r as { rowCount?: number }).rowCount) {
      return reply.code(404).send({ error: "Membership not found" });
    }
    return { removed: true };
  });
};
