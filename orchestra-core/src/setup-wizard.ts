import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";

export const GitProviderSchema = z.enum(["github", "gitlab"]);
export type GitProvider = z.infer<typeof GitProviderSchema>;

export const SetupConfigSchema = z.object({
  organization: z.string().min(1),
  git: z.object({
    provider: GitProviderSchema,
    token: z.string().min(1),
    org: z.string().optional(),
    useExistingOrg: z.boolean(),
  }),
  telegram: z.object({
    botToken: z.string().min(1),
  }),
  project: z
    .object({
      name: z.string().min(1),
      description: z.string().optional(),
    })
    .optional(),
});
export type SetupConfig = z.infer<typeof SetupConfigSchema>;

const CONFIG_PATH = process.env.CONFIG_PATH || "/app/orchestra.config.yaml";

export class SetupWizard {
  private rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async run(): Promise<SetupConfig> {
    console.log("\n🎵 AI Orchestra — Setup Wizard\n");

    // Step 1: Organization
    const organization = await this.ask("Organization/team name:");

    // Step 2: Git provider
    const providerInput = await this.ask("Git provider (github/gitlab):", "github");
    const provider = GitProviderSchema.parse(providerInput);

    const token = await this.ask(`${provider} personal access token:`);

    const useExistingOrg = (await this.ask("Use existing organization? (y/n):", "y")) === "y";
    let org: string | undefined;
    if (useExistingOrg) {
      org = await this.ask("Organization name:");
    }

    // Step 3: Verify Claude CLI
    console.log("\nChecking Claude CLI...");
    this.verifyClaudeCli();

    // Step 4: Verify Superpowers plugin
    console.log("Checking Superpowers plugin...");
    this.verifySuperpowers();

    // Step 5: Telegram
    const botToken = await this.ask("\nTelegram bot token (from @BotFather):");

    // Step 6: First project (optional)
    const createProject = (await this.ask("\nCreate first project? (y/n):", "y")) === "y";
    let project: SetupConfig["project"];
    if (createProject) {
      const projectName = await this.ask("Project name:");
      const projectDesc = await this.ask("Project description (optional):", "");
      project = {
        name: projectName,
        description: projectDesc || undefined,
      };
    }

    this.rl.close();

    const config = SetupConfigSchema.parse({
      organization,
      git: { provider, token, org, useExistingOrg },
      telegram: { botToken },
      project,
    });

    // Save config
    this.saveConfig(config);

    // Save .env
    this.saveEnv(config);

    // Initialize OpenProject (activate users, generate API token)
    console.log("\nInitializing OpenProject...");
    await this.initOpenProject();

    console.log("\n✅ Setup complete!");
    console.log(`Config saved to ${CONFIG_PATH}`);

    if (project) {
      console.log(`\nFirst project "${project.name}" ready.`);
      console.log("Start with: docker compose up");
      console.log("Then message your Tech Lead bot in Telegram.");
    }

    return config;
  }

  private verifyClaudeCli(): void {
    try {
      const version = execFileSync("claude", ["--version"], {
        encoding: "utf-8",
      }).trim();
      console.log(`  ✅ Claude CLI found: ${version}`);
    } catch {
      console.log("  ⚠️  Claude CLI not found. Install it before running agents.");
      console.log("     See: https://docs.anthropic.com/en/docs/claude-code");
    }
  }

  private verifySuperpowers(): void {
    try {
      const plugins = execFileSync("claude", ["plugins", "list"], {
        encoding: "utf-8",
      });
      if (plugins.includes("superpowers")) {
        console.log("  ✅ Superpowers plugin installed");
      } else {
        console.log("  ⚠️  Superpowers plugin not found. Installing...");
        try {
          execFileSync("claude", ["plugins", "install", "superpowers@claude-plugins-official"]);
          console.log("  ✅ Superpowers plugin installed");
        } catch {
          console.log("  ⚠️  Could not install Superpowers. Install manually:");
          console.log("     claude plugins install superpowers@claude-plugins-official");
        }
      }
    } catch {
      console.log("  ⚠️  Could not check plugins. Verify Superpowers manually.");
    }
  }

  private async initOpenProject(): Promise<void> {
    try {
      // Run the init script inside the OpenProject container
      const output = execFileSync("docker", [
        "compose", "exec", "-T", "openproject",
        "bash", "/app/openproject-init.sh"
      ], { encoding: "utf-8", timeout: 60000 });

      console.log(output);

      // Extract API token if generated
      const tokenMatch = output.match(/API_TOKEN=(\S+)/);
      if (tokenMatch) {
        const apiToken = tokenMatch[1];
        console.log(`  ✅ OpenProject API token generated`);

        // Append to .env
        const envPath = path.resolve(CONFIG_PATH, "..", ".env");
        if (existsSync(envPath)) {
          let env = readFileSync(envPath, "utf-8");
          env = env.replace(/OPENPROJECT_API_KEY=.*/, `OPENPROJECT_API_KEY=${apiToken}`);
          writeFileSync(envPath, env);
          console.log(`  ✅ API key saved to .env`);
        }
      }
    } catch (err) {
      console.log("  ⚠️  Could not initialize OpenProject automatically.");
      console.log("     Run manually: docker compose exec openproject bash /app/openproject-init.sh");
      console.log(`     Error: ${(err as Error).message}`);
    }
  }

  private saveConfig(config: SetupConfig): void {
    const yaml = [
      `organization: "${config.organization}"`,
      "",
      "git:",
      `  provider: ${config.git.provider}`,
      `  org: "${config.git.org || ""}"`,
      "",
      "openproject:",
      "  url: http://localhost:8080",
      "",
      "n8n:",
      "  url: http://localhost:5678",
      "",
      "agents:",
      "  session_timeout_hours: 8",
      "  max_concurrent: 5",
      "",
    ];

    if (config.project) {
      yaml.push("projects:");
      yaml.push(`  - name: "${config.project.name}"`);
      if (config.project.description) {
        yaml.push(`    description: "${config.project.description}"`);
      }
    }

    writeFileSync(CONFIG_PATH, yaml.join("\n") + "\n");
  }

  private saveEnv(config: SetupConfig): void {
    const envPath = path.resolve(CONFIG_PATH, "..", ".env");

    // Read existing .env if present
    let existing = "";
    if (existsSync(envPath)) {
      existing = readFileSync(envPath, "utf-8");
    }

    const envVars: Record<string, string> = {
      GIT_PROVIDER: config.git.provider,
      GIT_TOKEN: config.git.token,
      GIT_ORG: config.git.org || "",
      TELEGRAM_BOT_TOKEN: config.telegram.botToken,
    };

    // Merge with existing, don't overwrite already-set values
    for (const [key, value] of Object.entries(envVars)) {
      const regex = new RegExp(`^${key}=`, "m");
      if (!regex.test(existing)) {
        existing += `${key}=${value}\n`;
      }
    }

    writeFileSync(envPath, existing);
    console.log(`Environment saved to ${envPath}`);
  }

  private ask(question: string, defaultValue?: string): Promise<string> {
    const prompt = defaultValue ? `${question} [${defaultValue}] ` : `${question} `;
    return new Promise((resolve) => {
      this.rl.question(prompt, (answer) => {
        resolve(answer.trim() || defaultValue || "");
      });
    });
  }
}

// Run wizard if called directly
const isMain = process.argv[1]?.endsWith("setup-wizard.js") ||
  process.argv[1]?.endsWith("setup-wizard.ts");

if (isMain) {
  const wizard = new SetupWizard();
  wizard.run().catch((err) => {
    console.error("Setup failed:", err);
    process.exit(1);
  });
}
