import { z } from "zod";

export const OrchestraConfigSchema = z.object({
  port: z.number().int().positive(),
  databaseUrl: z.string().url(),
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
