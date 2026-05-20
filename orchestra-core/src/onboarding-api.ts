import type { FastifyPluginAsync } from "fastify";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db";
import { users, projects, projectMembers, systemConfig } from "./db/schema";
import { currentUserId } from "./auth";
import {
  claudeLoggedIn,
  codexLoggedIn,
  hostClaudeAuthAvailable,
  hostCodexAuthAvailable,
} from "./per-project-creds";

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

const stepKeySchema = z.enum(["claude_auth", "project", "git_token", "telegram"]);

export const StepSchema = z.object({
  key: stepKeySchema,
  title: z.string(),
  done: z.boolean(),
  href: z.string(),
  hint: z.string().optional(),
  // Optional steps render normally in the checklist but don't block
  // the "all done" computation — so a user who never wants Telegram
  // isn't stuck with a permanently-unfinished checklist.
  optional: z.boolean().optional(),
});

export const TabKeySchema = z.enum([
  "kanban", "chat", "signals", "agents", "flow", "logs", "settings", "profile",
]);
export type OnboardingTabKey = z.infer<typeof TabKeySchema>;

export const OnboardingSchema = z.object({
  dismissedAt: z.string().nullable(),
  welcomeSeenAt: z.string().nullable(),
  showWelcome: z.boolean(),
  allDone: z.boolean(),
  steps: z.array(StepSchema),
  tabsSeen: z.array(TabKeySchema),
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

  // Distinct from /dismiss: marks that the user has closed the welcome
  // modal (Skip / Next-through / X). Stops the modal from reappearing on
  // reload without affecting the checklist visibility.
  app.post("/onboarding/welcome-seen", async (request) => {
    const userId = currentUserId(request);
    await getDb()
      .update(users)
      .set({ onboardingWelcomeSeenAt: sql`now()` })
      .where(eq(users.id, userId));
    return await computeOnboarding(userId);
  });

  // Mark a tab's coachmark tour as seen. Idempotent — uses a JSONB array
  // append guarded by a containment check so re-posts are no-ops.
  app.post<{ Params: { key: string } }>("/onboarding/tabs/:key", async (request, reply) => {
    const parsed = TabKeySchema.safeParse(request.params.key);
    if (!parsed.success) return reply.code(400).send({ error: "Неизвестный ключ вкладки" });
    const userId = currentUserId(request);
    const key = parsed.data;
    await getDb()
      .update(users)
      .set({
        onboardingTabsSeen: sql`
          CASE
            WHEN ${users.onboardingTabsSeen} @> ${JSON.stringify([key])}::jsonb
              THEN ${users.onboardingTabsSeen}
            ELSE ${users.onboardingTabsSeen} || ${JSON.stringify([key])}::jsonb
          END
        `,
      })
      .where(eq(users.id, userId));
    return await computeOnboarding(userId);
  });
};

export async function computeOnboarding(userId: string) {
  const db = getDb();

  const [user] = await db
    .select({
      dismissedAt: users.onboardingDismissedAt,
      welcomeSeenAt: users.onboardingWelcomeSeenAt,
      tabsSeen: users.onboardingTabsSeen,
    })
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

  // Credentials are now strictly per-project. Until the user has at least
  // one project, none of the credential steps apply. Once they do, each
  // step is ticked from THAT project's settings — never from env or
  // system_config, which would let User A's token unlock User B's
  // checklist on a shared deployment.
  //
  // Mode (max vs api) is still a deployment-wide preference in
  // system_config.claude_auth — it's a default, not a credential. We
  // read it so a project that's intentionally on Max mode (no API key
  // needed) still ticks the step.
  const sysConfigRows = await db.select().from(systemConfig);
  const sysMap = Object.fromEntries(sysConfigRows.map((r) => [r.key, r.value]));

  // AI provider step: the project must have a usable login for AT LEAST
  // one provider (Claude or Codex). Either provider satisfies the step —
  // a user who only wants Codex can leave Claude blank, and vice versa.
  //
  // Max / subscription modes now require a real per-project credentials
  // file (we no longer trust the host's ~/.claude or ~/.codex implicitly).
  // BUT: when the host has a global login AND the project hasn't yet
  // triggered the lazy seed (which only fires on first spawn), we still
  // count the step done — the seed will succeed when the user tries to
  // spawn an agent.
  const hostClaudeReady = hostClaudeAuthAvailable();
  const hostCodexReady = hostCodexAuthAvailable();
  const claudeDefaultMode = (sysMap.claude_auth ?? "max") as "max" | "api";

  const projectAiProviderReady = (p: { id: string; settings: unknown }): boolean => {
    // Claude side
    const claude = (p.settings as { claude?: { auth?: "max" | "api"; apiKey?: string } } | null)?.claude;
    const claudeMode = (claude?.auth ?? claudeDefaultMode) as "max" | "api";
    if (claudeMode === "api" && claude?.apiKey) return true;
    if (claudeMode === "max" && (claudeLoggedIn(p.id) || hostClaudeReady)) return true;

    // Codex side
    const codex = (p.settings as { codex?: { auth?: "subscription" | "api"; apiKey?: string } } | null)?.codex;
    if (codex?.auth === "api" && codex?.apiKey) return true;
    if (codex?.auth === "subscription" && (codexLoggedIn(p.id) || hostCodexReady)) return true;

    return false;
  };

  const aiProviderDone = hasProject && visibleProjects.some(projectAiProviderReady);

  // Git token: every project that talks to a remote MUST have its own
  // token in settings.provider.token. local_path-only projects don't
  // need one. The step is "done" when every remote-using project has a
  // token configured (or all projects are local-only).
  const projectsNeedingToken = visibleProjects.filter((p) => !p.localPath && p.repoUrl);
  const gitTokenDone =
    hasProject &&
    (projectsNeedingToken.length === 0 ||
      projectsNeedingToken.every((p) => {
        const s = (p.settings as { provider?: { token?: string } } | null)?.provider;
        return !!s?.token;
      }));

  // Telegram is optional — auto-tick once the user has a project and at
  // least one of their projects has a bot wired up. Don't pre-tick for
  // users with no project yet (was the other source of the 3-of-4 bug).
  const telegramAny = visibleProjects.some((p) => {
    const tg = (p.settings as { telegram?: { botToken?: string } } | null)?.telegram;
    return !!tg?.botToken;
  });
  const telegramDone = hasProject && telegramAny;

  const steps = [
    {
      // Key kept as `claude_auth` for backward compat (it's in stepKeySchema
      // and the user_onboarding.dismissed_steps history). Title reflects
      // the new reality: either Claude OR Codex satisfies the step.
      key: "claude_auth" as const,
      title: "Настроить ИИ-провайдера (Claude или Codex)",
      done: aiProviderDone,
      href: "/settings",
      hint: "Авторизуйтесь в Claude или Codex для проекта (подписка или API-ключ). Без этого агенты не смогут запускаться.",
    },
    {
      key: "project" as const,
      title: "Создать первый проект",
      done: hasProject,
      href: "/settings",
      hint: "Укажите AI Orchestra на git-репозиторий или локальную папку.",
    },
    {
      key: "git_token" as const,
      title: "Указать токен GitHub или GitLab",
      done: gitTokenDone,
      href: "/settings",
      hint: "Нужен для операций с PR на удалённых репозиториях. Можно пропустить, если используете только локальные пути.",
    },
    {
      key: "telegram" as const,
      title: "Подключить Telegram (необязательно)",
      done: telegramDone,
      href: "/settings",
      hint: "У каждого проекта свой бот. Пропустите, если уведомления на телефон не нужны.",
      optional: true,
    },
  ];

  // Required steps gate the "all done" pill; optional ones can stay
  // unchecked forever without keeping the checklist alive.
  const allDone = steps.filter((s) => !s.optional).every((s) => s.done);
  const dismissedAt = user?.dismissedAt ?? null;
  const welcomeSeenAt = user?.welcomeSeenAt ?? null;
  const rawTabs = (user?.tabsSeen ?? []) as unknown;
  // The column has a NOT NULL default of [] but be defensive: validate
  // and silently drop unknown keys (a future schema can shrink/rename).
  const tabsSeen = Array.isArray(rawTabs)
    ? rawTabs
      .map((t) => TabKeySchema.safeParse(t))
      .filter((r) => r.success)
      .map((r) => (r as { success: true; data: OnboardingTabKey }).data)
    : [];

  return {
    dismissedAt: dismissedAt ? dismissedAt.toISOString() : null,
    welcomeSeenAt: welcomeSeenAt ? welcomeSeenAt.toISOString() : null,
    // Welcome modal: hide once the user has explicitly closed it OR they
    // already have a project (so a long-time user the field rolled out to
    // doesn't see the intro at all). Also suppressed by the checklist's
    // global dismiss — that's a stronger "I don't want any of this" signal.
    showWelcome: !welcomeSeenAt && !dismissedAt && !hasProject,
    allDone,
    steps,
    tabsSeen,
  };
}
