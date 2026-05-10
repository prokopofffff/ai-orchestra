import type { FastifyPluginAsync } from "fastify";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db";
import { users, projects, projectMembers, systemConfig } from "./db/schema";
import { currentUserId } from "./auth";

/**
 * Onboarding tracks one piece of explicit state — whether the user has
 * dismissed the welcome flow — and computes step completion from real data:
 *
 *   - claude_auth:  "max" + maxAuth available, OR an explicit api_key in
 *                   system_config (or env), OR the user has touched the
 *                   System tab (claude_auth row exists in system_config).
 *   - project:      user owns or is a member of at least one project.
 *   - git_token:    a token is set somewhere it would be picked up — env
 *                   var, system_config, or project provider settings —
 *                   OR every project of the user uses local_path (no token
 *                   needed for those).
 *
 * Computing live means the checklist can never disagree with the rest of
 * the app: turn on auth → step ticks; create a project → step ticks.
 */

const stepKeySchema = z.enum(["claude_auth", "project", "git_token"]);

export const StepSchema = z.object({
  key: stepKeySchema,
  title: z.string(),
  done: z.boolean(),
  href: z.string(),
  hint: z.string().optional(),
});

export const OnboardingSchema = z.object({
  dismissedAt: z.string().nullable(),
  showWelcome: z.boolean(),
  allDone: z.boolean(),
  steps: z.array(StepSchema),
});

export const onboardingPlugin: FastifyPluginAsync = async (app) => {
  app.get("/onboarding", async (request) => {
    const userId = currentUserId(request);
    return await computeOnboarding(userId);
  });

  app.post("/onboarding/dismiss", async (request) => {
    const userId = currentUserId(request);
    await getDb()
      .update(users)
      .set({ onboardingDismissedAt: sql`now()` })
      .where(eq(users.id, userId));
    return await computeOnboarding(userId);
  });
};

export async function computeOnboarding(userId: string) {
  const db = getDb();

  const [user] = await db
    .select({ dismissedAt: users.onboardingDismissedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // Project step: at least one project the user can see.
  const ownedRows = await db
    .select({ id: projects.id, repoUrl: projects.repoUrl, localPath: projects.localPath, settings: projects.settings })
    .from(projects)
    .where(eq(projects.ownerId, userId));
  const memberRows = await db
    .select({ id: projects.id, repoUrl: projects.repoUrl, localPath: projects.localPath, settings: projects.settings })
    .from(projects)
    .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
    .where(eq(projectMembers.userId, userId));
  const visibleProjects = [...ownedRows, ...memberRows];
  const hasProject = visibleProjects.length > 0;

  // Claude auth step: any signal the user (or env) has wired up Claude.
  // If the deployment runs in `max` mode and there's no explicit API key
  // configured, we count the row in system_config as the act of choosing.
  const sysConfigRows = await db.select().from(systemConfig);
  const sysMap = Object.fromEntries(sysConfigRows.map((r) => [r.key, r.value]));
  const claudeAuthDone =
    !!sysMap.claude_auth ||
    !!sysMap.claude_api_key ||
    !!process.env.ANTHROPIC_API_KEY ||
    !!process.env.CLAUDE_API_KEY;

  // Git token step: any git provider token reachable from this user's
  // projects, or all their projects use local_path (no token needed).
  const projectsNeedingToken = visibleProjects.filter((p) => !p.localPath && p.repoUrl);
  const projectTokenSet = projectsNeedingToken.some((p) => {
    const s = (p.settings as { provider?: { token?: string } } | null)?.provider;
    return !!s?.token;
  });
  const globalToken = !!sysMap.github_token || !!process.env.GITHUB_TOKEN || !!process.env.GITLAB_TOKEN;
  // If they don't have any project that *needs* a token yet, treat the
  // step as not-applicable-yet → done so it doesn't nag a local-path-only
  // user. As soon as they add a remote-repo project, the step re-opens.
  const gitTokenDone = projectsNeedingToken.length === 0 ? true : projectTokenSet || globalToken;

  const steps = [
    {
      key: "claude_auth" as const,
      title: "Configure Claude authentication",
      done: claudeAuthDone,
      href: "/settings",
      hint: "Choose Max subscription or an API key. Without this, agents can't run.",
    },
    {
      key: "project" as const,
      title: "Create your first project",
      done: hasProject,
      href: "/settings",
      hint: "Point AI Orchestra at a git repo or local directory.",
    },
    {
      key: "git_token" as const,
      title: "Set a GitHub or GitLab token",
      done: gitTokenDone,
      href: "/settings",
      hint: "Needed for PR operations on remote repos. Skip if you only use local paths.",
    },
  ];

  const allDone = steps.every((s) => s.done);
  const dismissedAt = user?.dismissedAt ?? null;

  return {
    dismissedAt: dismissedAt ? dismissedAt.toISOString() : null,
    // Welcome modal: never dismissed AND user hasn't created a project yet.
    // A returning user who already has projects doesn't see the intro again
    // even if they never explicitly dismissed it. The git_token step can
    // auto-tick on a fresh account with no projects (no remote project →
    // nothing needing a token), so we key on hasProject specifically.
    showWelcome: !dismissedAt && !hasProject,
    allDone,
    steps,
  };
}
