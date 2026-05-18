import * as p from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const ENV_PATH = path.join(__dirname, "..", "..", ".env");

async function main() {
  p.intro("AI Orchestra — Setup");

  // ─── Claude Auth ───
  const claudeAuth = await p.select({
    message: "Claude authentication:",
    options: [
      { value: "max", label: "Claude Max subscription (claude CLI already logged in)" },
      { value: "api", label: "Claude API key" },
    ],
  });
  if (p.isCancel(claudeAuth)) return process.exit(0);

  // Claude API keys are per-project now. The wizard sets only the default
  // *mode*; if api mode is chosen, each project pastes its own key in
  // Project Settings → Claude credentials. Avoids a global key
  // authorizing every user's projects.
  if (claudeAuth === "api") {
    p.log.info(
      "API mode set as default. Paste each project's Claude API key in Project Settings → Claude credentials.",
    );
  }

  // ─── Pencil CLI ───
  let pencilEnabled = false;
  let pencilModel = "claude-sonnet-4-6";

  const usePencil = await p.confirm({
    message: "Enable Pencil CLI for design generation? (creates .pen design files)",
    initialValue: true,
  });
  if (p.isCancel(usePencil)) return process.exit(0);

  if (usePencil) {
    // Check if already logged in
    let loggedIn = false;
    try {
      const status = execSync("pencil status 2>&1", { encoding: "utf-8" });
      loggedIn = status.includes("Active");
    } catch { /* not installed or not logged in */ }

    if (loggedIn) {
      p.log.success("Pencil CLI: already logged in");
      pencilEnabled = true;
    } else {
      // Check if pencil CLI is installed
      let installed = false;
      try {
        execSync("pencil version", { stdio: "pipe" });
        installed = true;
      } catch { /* not installed */ }

      if (!installed) {
        p.log.info("Installing Pencil CLI...");
        try {
          execSync("npm install -g @pencil.dev/cli", { stdio: "pipe" });
          installed = true;
          p.log.success("Pencil CLI installed");
        } catch {
          p.log.error("Failed to install Pencil CLI. You can install manually: npm install -g @pencil.dev/cli");
        }
      }

      if (installed) {
        p.log.info("Run `pencil login` to authenticate with your Pencil account.");
        const doLogin = await p.confirm({
          message: "Login to Pencil now? (opens interactive login)",
          initialValue: true,
        });
        if (p.isCancel(doLogin)) return process.exit(0);

        if (doLogin) {
          p.log.info("Starting Pencil login... Follow the prompts below.");
          try {
            execSync("pencil login", { stdio: "inherit" });
            // Verify
            const status = execSync("pencil status 2>&1", { encoding: "utf-8" });
            if (status.includes("Active")) {
              p.log.success("Pencil login successful");
              pencilEnabled = true;
            }
          } catch {
            p.log.error("Pencil login failed. Designer will use STYLE.md only.");
          }
        }
      }
    }

    if (pencilEnabled) {
      const model = await p.select({
        message: "Pencil design model:",
        options: [
          { value: "claude-sonnet-4-6", label: "Sonnet (recommended, fast)" },
          { value: "claude-opus-4-6", label: "Opus (best quality, slower)" },
          { value: "claude-haiku-4-5", label: "Haiku (fastest, basic)" },
        ],
        initialValue: "claude-sonnet-4-6",
      });
      if (p.isCancel(model)) return process.exit(0);
      pencilModel = model;
    }
  }

  // ─── Telegram ───
  const telegramToken = await p.text({
    message: "Telegram Bot Token (Enter to skip):",
    placeholder: "123456:ABC-DEF...",
    defaultValue: "",
  });
  if (p.isCancel(telegramToken)) return process.exit(0);

  let telegramChatId = "";
  if (telegramToken) {
    const chatId = await p.text({
      message: "Telegram Chat ID:",
      placeholder: "123456789",
      defaultValue: "",
    });
    if (p.isCancel(chatId)) return process.exit(0);
    telegramChatId = chatId;
  }

  // ─── GitHub ───
  // No GITHUB_TOKEN prompt — tokens are per-project now (set under
  // Project Settings → Git provider token). Asking for a global token
  // here would silently authorize every project; that was the bug.
  p.log.info(
    "GitHub / GitLab tokens are per-project — paste them in Project Settings after creating a project.",
  );

  const org = await p.text({
    message: "GitHub default org/owner (Enter to skip):",
    placeholder: "myorg",
    defaultValue: "",
  });
  if (p.isCancel(org)) return process.exit(0);
  const githubOrg = org;

  const githubBranch = await p.text({
    message: "Default branch:",
    defaultValue: "main",
  });
  if (p.isCancel(githubBranch)) return process.exit(0);

  // ─── Models ───
  const modelTechLead = await p.select({
    message: "Tech Lead model:",
    options: [
      { value: "opus", label: "Opus (recommended)" },
      { value: "sonnet", label: "Sonnet" },
      { value: "haiku", label: "Haiku" },
    ],
    initialValue: "opus",
  });
  if (p.isCancel(modelTechLead)) return process.exit(0);

  const modelDefault = await p.select({
    message: "Default model for other agents:",
    options: [
      { value: "sonnet", label: "Sonnet (recommended)" },
      { value: "opus", label: "Opus" },
      { value: "haiku", label: "Haiku" },
    ],
    initialValue: "sonnet",
  });
  if (p.isCancel(modelDefault)) return process.exit(0);

  // ─── First Project ───
  const createProject = await p.confirm({
    message: "Create first project?",
    initialValue: true,
  });
  if (p.isCancel(createProject)) return process.exit(0);

  let projectName = "";
  let projectRepo = "";
  if (createProject) {
    const name = await p.text({
      message: "Project name:",
      placeholder: "my-app",
      validate: (v) => (v.length < 1 ? "Name required" : undefined),
    });
    if (p.isCancel(name)) return process.exit(0);
    projectName = name;

    const repo = await p.text({
      message: "Repository URL (Enter to skip):",
      placeholder: "https://github.com/org/repo",
      defaultValue: "",
    });
    if (p.isCancel(repo)) return process.exit(0);
    projectRepo = repo;
  }

  // ─── Generate .env ───
  const postgresPassword = crypto.randomBytes(24).toString("base64url");
  const sessionSecret = crypto.randomBytes(24).toString("base64url");

  // Credentials (CLAUDE_API_KEY, GITHUB_TOKEN, GITLAB_TOKEN) are
  // intentionally NOT written here — they're per-project (see
  // Project Settings → Claude credentials / Git provider token).
  // A global value in .env would silently authorize every user's
  // agent runs against the same account.
  const envContent = `# Required
CLAUDE_AUTH=${claudeAuth}

# Pencil CLI
PENCIL_ENABLED=${pencilEnabled}
PENCIL_MODEL=${pencilModel}

# Optional
TELEGRAM_BOT_TOKEN=${telegramToken}
TELEGRAM_CHAT_ID=${telegramChatId}
GITHUB_DEFAULT_ORG=${githubOrg}
GITHUB_DEFAULT_BRANCH=${githubBranch}

# Agent models
MODEL_TECH_LEAD=${modelTechLead}
MODEL_DESIGNER=${modelDefault}
MODEL_FRONTEND=${modelDefault}
MODEL_BACKEND=${modelDefault}
MODEL_QA=${modelDefault}
MODEL_DEVOPS=${modelDefault}

# Auto-generated
POSTGRES_PASSWORD=${postgresPassword}
SESSION_SECRET=${sessionSecret}

# First project (used by orchestra-core on first boot)
FIRST_PROJECT_NAME=${projectName}
FIRST_PROJECT_REPO=${projectRepo}
`;

  fs.writeFileSync(ENV_PATH, envContent);

  p.outro(`Config saved to .env\n${pencilEnabled ? "Pencil CLI: enabled" : "Pencil CLI: disabled (designer will use STYLE.md only)"}\nRun \`docker compose up\` to start`);
}

main().catch(console.error);
