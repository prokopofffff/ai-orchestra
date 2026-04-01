import * as p from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ENV_PATH = path.join(__dirname, "..", "..", ".env");

async function main() {
  p.intro("AI Orchestra — Setup");

  const claudeAuth = await p.select({
    message: "Claude authentication:",
    options: [
      { value: "max", label: "Claude Max subscription (claude CLI already logged in)" },
      { value: "api", label: "Claude API key" },
    ],
  });
  if (p.isCancel(claudeAuth)) return process.exit(0);

  let claudeApiKey = "";
  if (claudeAuth === "api") {
    const key = await p.text({ message: "Claude API key:", validate: (v) => (v.length < 10 ? "Invalid key" : undefined) });
    if (p.isCancel(key)) return process.exit(0);
    claudeApiKey = key;
  }

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

  const githubToken = await p.text({
    message: "GitHub Token (Enter to skip):",
    placeholder: "ghp_xxxx...",
    defaultValue: "",
  });
  if (p.isCancel(githubToken)) return process.exit(0);

  let githubOrg = "";
  if (githubToken) {
    const org = await p.text({
      message: "GitHub default org/owner:",
      placeholder: "myorg",
      defaultValue: "",
    });
    if (p.isCancel(org)) return process.exit(0);
    githubOrg = org;
  }

  const githubBranch = await p.text({
    message: "Default branch:",
    defaultValue: "main",
  });
  if (p.isCancel(githubBranch)) return process.exit(0);

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

  const postgresPassword = crypto.randomBytes(24).toString("base64url");
  const sessionSecret = crypto.randomBytes(24).toString("base64url");

  const envContent = `# Required
CLAUDE_AUTH=${claudeAuth}
CLAUDE_API_KEY=${claudeApiKey}

# Optional
TELEGRAM_BOT_TOKEN=${telegramToken}
TELEGRAM_CHAT_ID=${telegramChatId}
GITHUB_TOKEN=${githubToken}
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

  p.outro(`Config saved to .env\nRun \`docker compose up\` to start`);
}

main().catch(console.error);
