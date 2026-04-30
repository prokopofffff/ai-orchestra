import { z } from "zod";

const modelSchema = z.enum(["opus", "sonnet", "haiku"]);

export const configSchema = z.object({
  port: z.coerce.number().default(3000),
  nodeEnv: z.string().default("development"),
  databaseUrl: z.string().url(),
  jwtSecret: z.string().min(16, "JWT_SECRET must be at least 16 characters"),

  claudeAuth: z.enum(["max", "api"]).default("max"),
  claudeApiKey: z.string().optional(),

  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),

  githubToken: z.string().optional(),
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
  return configSchema.parse({
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me-please-it-must-be-long",
    claudeAuth: process.env.CLAUDE_AUTH,
    claudeApiKey: process.env.CLAUDE_API_KEY,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
    githubToken: process.env.GITHUB_TOKEN || undefined,
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
