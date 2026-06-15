import { z } from "zod";

const modelSchema = z.enum(["opus", "sonnet", "haiku"]);

export const configSchema = z.object({
  port: z.coerce.number().default(3000),
  nodeEnv: z.string().default("development"),
  databaseUrl: z.string().url(),
  jwtSecret: z.string().min(16, "JWT_SECRET must be at least 16 characters"),

  // Deployment-wide default mode (max vs api). Per-project
  // settings.claude.auth overrides this. Not a credential — safe to share.
  claudeAuth: z.enum(["max", "api"]).default("max"),

  // Telegram is per-project now (projects.settings.telegram). Kept in the
  // schema as deprecated-optional only so legacy .env files don't fail to
  // load — values are ignored at runtime.
  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),

  // Defaults for new projects — not credentials.
  githubDefaultOrg: z.string().optional(),
  githubDefaultBranch: z.string().default("main"),

  modelTechLead: modelSchema.default("opus"),
  modelDesigner: modelSchema.default("sonnet"),
  modelFrontend: modelSchema.default("sonnet"),
  modelBackend: modelSchema.default("sonnet"),
  modelQa: modelSchema.default("sonnet"),
  modelDevops: modelSchema.default("sonnet"),

  pencilEnabled: z.coerce.boolean().default(false),
  pencilModel: z.string().default("claude-sonnet-4-6"),

  dashboardPath: z.string().default("../dashboard/dist"),
});

export type Config = z.infer<typeof configSchema>;

export type AgentRole = "tech-lead" | "designer" | "frontend" | "backend" | "qa" | "devops";

export function loadConfig(): Config {
  // Fail closed in production: a hardcoded fallback secret means anyone can
  // forge a session/agent JWT and take over every project. Only fall back to
  // the well-known dev secret outside production so local `pnpm dev` / tests
  // still boot without ceremony.
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && !process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET must be set in production — refusing to start with a default secret");
  }

  return configSchema.parse({
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me-please-it-must-be-long",
    claudeAuth: process.env.CLAUDE_AUTH,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
    githubDefaultOrg: process.env.GITHUB_DEFAULT_ORG || undefined,
    githubDefaultBranch: process.env.GITHUB_DEFAULT_BRANCH,
    modelTechLead: process.env.MODEL_TECH_LEAD,
    modelDesigner: process.env.MODEL_DESIGNER,
    modelFrontend: process.env.MODEL_FRONTEND,
    modelBackend: process.env.MODEL_BACKEND,
    modelQa: process.env.MODEL_QA,
    modelDevops: process.env.MODEL_DEVOPS,
    pencilEnabled: process.env.PENCIL_ENABLED,
    pencilModel: process.env.PENCIL_MODEL,
    dashboardPath: process.env.DASHBOARD_PATH,
  });
}

const modelMap: Record<AgentRole, keyof Config> = {
  "tech-lead": "modelTechLead",
  designer: "modelDesigner",
  frontend: "modelFrontend",
  backend: "modelBackend",
  qa: "modelQa",
  devops: "modelDevops",
};

export function getModelForRole(config: Config, role: AgentRole, projectSettings?: Record<string, unknown>): string {
  const projectModel = projectSettings?.["models"] as Record<string, string> | undefined;
  if (projectModel?.[role]) return projectModel[role];
  return config[modelMap[role]] as string;
}

/**
 * Per-role effort override (low/medium/high/max). Returns undefined when
 * nothing is configured — let the SDK pick its default ("high") rather
 * than baking that constant into the orchestrator.
 */
export type EffortLevel = "low" | "medium" | "high" | "max";

export function getEffortForRole(
  role: AgentRole,
  projectSettings?: Record<string, unknown>,
): EffortLevel | undefined {
  const override = projectSettings?.["effort"] as Record<string, string> | undefined;
  const value = override?.[role];
  if (value === "low" || value === "medium" || value === "high" || value === "max") return value;
  return undefined;
}
