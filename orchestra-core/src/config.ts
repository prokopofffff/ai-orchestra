import { z } from "zod";

export const OrchestraConfigSchema = z.object({
  port: z.number().int().positive(),
  databaseUrl: z.string().url(),
  n8n: z.object({
    url: z.string().url(),
    user: z.string(),
    password: z.string(),
  }),
  openproject: z.object({
    url: z.string().url(),
    apiKey: z.string(),
  }),
  claude: z.object({
    cliPath: z.string(),
  }),
  telegram: z.object({
    botToken: z.string(),
    chatId: z.string(),
  }),
});

export type OrchestraConfig = z.infer<typeof OrchestraConfigSchema>;

export function loadConfig(): OrchestraConfig {
  const raw = {
    port: parseInt(process.env.PORT || "3000", 10),
    databaseUrl: process.env.DATABASE_URL,
    n8n: {
      url: process.env.N8N_URL,
      user: process.env.N8N_USER || "admin",
      password: process.env.N8N_PASSWORD || "admin",
    },
    openproject: {
      url: process.env.OPENPROJECT_URL,
      apiKey: process.env.OPENPROJECT_API_KEY || "",
    },
    claude: {
      cliPath: process.env.CLAUDE_CLI_PATH || "claude",
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || "",
      chatId: process.env.TELEGRAM_CHAT_ID || "",
    },
  };

  const result = OrchestraConfigSchema.safeParse(raw);

  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  return result.data;
}
