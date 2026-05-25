import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { simpleGit } from "simple-git";
import { eq, and, sql } from "drizzle-orm";
import { getDb } from "./db";
import { projects, projectContextCards } from "./db/schema";
import { resolveRuntimeForRole } from "./agents/runtime/resolver";
import { resolveClaudeBin, resolveCodexBin } from "./bin-resolver";
import { loadConfig } from "./config";
import { log } from "./obs";

/**
 * Generate pre-computed context cards for a project. Each card is a
 * short, kind-specific summary (architecture / decisions / style /
 * recent_activity) inlined into the bootstrap prompt of OTHER projects
 * that reference this one (Phase 3 of the cross-project context plan).
 *
 * Why pre-compute: the alternative is to dump README + dir tree + recent
 * commits into every referencing project's bootstrap and let the agent
 * re-discover the structure each turn. With cards, ten linked references
 * cost ~5KB of fixed bootstrap tokens instead of growing unboundedly with
 * each ref project's size.
 *
 * Provider: re-uses the project's configured runtime (claude/codex)
 * through the existing auth resolver. ChatGPT-subscription codex runs
 * effectively free; Claude max runs at haiku rates (~$0.001/card).
 */

export type CardKind = "architecture" | "decisions" | "style" | "recent_activity";
export const KNOWN_CARD_KINDS: CardKind[] = ["architecture", "decisions", "style", "recent_activity"];

/** Target output length the generator asks the model for. Approximate. */
const CARD_TOKEN_TARGET = 500;
/** Hard cap on prompt input bytes per source file (README, CLAUDE.md, etc.). */
const SOURCE_FILE_CAP_BYTES = 8 * 1024;
/** Max chars we ever serialize for the directory listing. */
const DIR_LISTING_CAP_CHARS = 4_000;
/** Top-level dir skip list — same noise we already filter elsewhere. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache"]);

export interface GenerateOptions {
  /** When true, regenerate even if source_sha matches the existing card. */
  force?: boolean;
}

export interface GenerateResult {
  kind: CardKind;
  generated: boolean;
  /** Reason for skipping when generated === false. */
  reason?: string;
  card?: {
    content: string;
    tokenCount: number;
    sourceSha: string | null;
    generatorModel: string | null;
    costUsd: number;
  };
}

/**
 * Generate or refresh a single card. Idempotent — calling for an unchanged
 * project SHA skips the LLM call (unless `force=true`).
 */
export async function generateCard(
  projectId: string,
  kind: CardKind,
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  if (!KNOWN_CARD_KINDS.includes(kind)) {
    return { kind, generated: false, reason: `unknown card kind: ${kind}` };
  }

  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return { kind, generated: false, reason: "project not found" };
  if (!project.localPath) {
    return { kind, generated: false, reason: "project has no local_path — nothing to summarize" };
  }
  if (!fs.existsSync(project.localPath)) {
    return { kind, generated: false, reason: `local_path \`${project.localPath}\` does not exist` };
  }

  const sourceSha = await readHeadSha(project.localPath);

  if (!opts.force) {
    const existing = await db
      .select()
      .from(projectContextCards)
      .where(and(eq(projectContextCards.projectId, projectId), eq(projectContextCards.kind, kind)))
      .limit(1);
    if (existing[0] && existing[0].sourceSha && existing[0].sourceSha === sourceSha) {
      return { kind, generated: false, reason: `up-to-date (source_sha=${sourceSha})` };
    }
  }

  const inputs = collectInputs(project.localPath, kind);
  if (!inputs.hasContent) {
    return {
      kind, generated: false,
      reason: "nothing to summarize (no README/CLAUDE.md/package.json/source tree)",
    };
  }
  const prompt = buildPrompt(kind, project.name, inputs);

  // Use the project's own resolved runtime so the card generation respects
  // the same auth + provider preferences as agent runs. tech-lead is the
  // most universally-configured role.
  const resolved = await resolveRuntimeForRole({
    projectId, role: "tech-lead",
    settings: project.settings, config: loadConfig(),
  });
  if (!resolved.ok) {
    return { kind, generated: false, reason: `runtime auth: ${resolved.reason}` };
  }

  let result: { content: string; costUsd: number; model: string };
  try {
    result = resolved.resolved.provider === "claude"
      ? await runOneShotClaude(prompt, resolved.resolved.spawnEnv, project.localPath)
      : await runOneShotCodex(prompt, resolved.resolved.spawnEnv, project.localPath);
  } catch (err) {
    return { kind, generated: false, reason: `LLM call failed: ${(err as Error).message}` };
  }

  const trimmed = result.content.trim();
  if (!trimmed) {
    return { kind, generated: false, reason: "LLM returned empty content" };
  }
  const tokenCount = estimateTokens(trimmed);

  // UPSERT: same (project_id, kind) gets overwritten in place.
  await db.insert(projectContextCards).values({
    projectId,
    kind,
    content: trimmed,
    tokenCount,
    sourceSha,
    generatorModel: result.model,
    costUsd: result.costUsd,
  }).onConflictDoUpdate({
    target: [projectContextCards.projectId, projectContextCards.kind],
    set: {
      content: trimmed,
      tokenCount,
      sourceSha,
      generatorModel: result.model,
      costUsd: result.costUsd,
      generatedAt: sql`now()`,
    },
  });

  log.info(
    { projectId, kind, sourceSha, model: result.model, costUsd: result.costUsd, tokenCount },
    "context card regenerated",
  );

  return {
    kind, generated: true,
    card: {
      content: trimmed, tokenCount, sourceSha,
      generatorModel: result.model, costUsd: result.costUsd,
    },
  };
}

/** Generate every known kind in parallel. Each returns a result independently. */
export async function generateAllCards(
  projectId: string,
  opts: GenerateOptions = {},
): Promise<GenerateResult[]> {
  return Promise.all(KNOWN_CARD_KINDS.map((k) => generateCard(projectId, k, opts)));
}

// ────────────────────────────────────────────────────────────────────────────
// Input collection (filesystem walk)

interface CardInputs {
  hasContent: boolean;
  readme: string | null;
  claudeMd: string | null;
  packageJson: string | null;
  dirListing: string;
  recentCommits?: string;
}

function collectInputs(root: string, kind: CardKind): CardInputs {
  const readme = readCapped(findCaseInsensitive(root, ["README.md", "README.markdown", "README.rst", "README"]));
  const claudeMd = readCapped(findCaseInsensitive(root, ["CLAUDE.md", "AGENTS.md"]));
  const packageJson = readCapped(path.join(root, "package.json"));
  const dirListing = listTopLevel(root);
  const inputs: CardInputs = {
    hasContent: Boolean(readme || claudeMd || packageJson || dirListing),
    readme, claudeMd, packageJson, dirListing,
  };
  if (kind === "recent_activity") {
    inputs.recentCommits = readRecentCommits(root, 20);
  }
  return inputs;
}

function findCaseInsensitive(root: string, names: string[]): string | null {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  const lower = new Map(entries.filter((e) => e.isFile()).map((e) => [e.name.toLowerCase(), e.name]));
  for (const want of names) {
    const real = lower.get(want.toLowerCase());
    if (real) return path.join(root, real);
  }
  return null;
}

function readCapped(p: string | null): string | null {
  if (!p) return null;
  try {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(SOURCE_FILE_CAP_BYTES);
      const n = fs.readSync(fd, buf, 0, SOURCE_FILE_CAP_BYTES, 0);
      const text = buf.subarray(0, n).toString("utf-8").trim();
      return text || null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function listTopLevel(root: string): string {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return ""; }
  const lines: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    lines.push(`${e.isDirectory() ? "dir " : "file"}  ${e.name}`);
    if (lines.join("\n").length > DIR_LISTING_CAP_CHARS) break;
  }
  return lines.join("\n");
}

function readRecentCommits(root: string, limit: number): string {
  try {
    const g = simpleGit(root);
    // simple-git is async; collectInputs is sync. Bail and let kind=
    // recent_activity skip git for now — added in a follow-up that
    // restructures collectInputs to be async.
    void g;
    return "";
  } catch {
    return "";
  }
}

async function readHeadSha(root: string): Promise<string | null> {
  try {
    const g = simpleGit(root);
    const sha = await g.revparse(["HEAD"]);
    return sha.trim();
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt construction

function buildPrompt(kind: CardKind, projectName: string, inputs: CardInputs): string {
  const lines: string[] = [];
  lines.push(`You are writing a context card about project "${projectName}".`);
  lines.push(`This card will be inlined into the bootstrap prompt of OTHER projects that reference this one.`);
  lines.push(`Target length: ~${CARD_TOKEN_TARGET} tokens (be concise; prose, not bullet lists unless natural).`);
  lines.push("");
  lines.push(`Card kind: **${kind}**`);
  lines.push("");
  lines.push(kindInstructions(kind));
  lines.push("");

  if (inputs.readme) {
    lines.push("## Source: README");
    lines.push("```");
    lines.push(inputs.readme);
    lines.push("```");
  }
  if (inputs.claudeMd) {
    lines.push("## Source: CLAUDE.md / AGENTS.md");
    lines.push("```");
    lines.push(inputs.claudeMd);
    lines.push("```");
  }
  if (inputs.packageJson) {
    lines.push("## Source: package.json");
    lines.push("```json");
    lines.push(inputs.packageJson);
    lines.push("```");
  }
  if (inputs.dirListing) {
    lines.push("## Source: top-level directory listing");
    lines.push("```");
    lines.push(inputs.dirListing);
    lines.push("```");
  }
  if (inputs.recentCommits) {
    lines.push("## Source: recent commits");
    lines.push("```");
    lines.push(inputs.recentCommits);
    lines.push("```");
  }

  lines.push("");
  lines.push(
    "You are running with your working directory set to the project root and have read-only " +
    "tools available (Read, Glob, Grep, Bash for ls/cat/find). Use them to explore any " +
    "subdirectory whose contents you need before writing the card. Never ask clarifying " +
    "questions — if a path doesn't exist, infer what you can from what does and write the " +
    "best card the available evidence supports.",
  );
  lines.push("");
  lines.push("Output ONLY the card content — no preamble, no `Here is the card:` header.");
  return lines.join("\n");
}

function kindInstructions(kind: CardKind): string {
  switch (kind) {
    case "architecture":
      return [
        "Describe the architecture so another AI agent can understand the codebase in 30 seconds:",
        "- Tech stack (language, framework, runtime)",
        "- Entry points (server, CLI, build commands)",
        "- Key directories and what lives in each",
        "- External integrations (DB, APIs, queues)",
      ].join("\n");
    case "decisions":
      return [
        "Surface non-obvious design decisions that referencing projects should follow or learn from:",
        "- Why something is structured the way it is",
        "- Trade-offs explicitly chosen over alternatives",
        "- Conventions that wouldn't be obvious from reading code alone",
      ].join("\n");
    case "style":
      return [
        "Summarize the project's style conventions an agent should mirror:",
        "- Naming patterns (file names, exports, types)",
        "- Code organization preferences",
        "- Tooling (linters, formatters, test runners)",
        "- For UI projects: design tokens, component patterns",
      ].join("\n");
    case "recent_activity":
      return [
        "Summarize what's been happening on this project lately:",
        "- Recent themes from commit messages",
        "- Active areas of change",
        "- Anything that signals \"don't touch this — it's mid-refactor\"",
      ].join("\n");
  }
}

// ────────────────────────────────────────────────────────────────────────────
// One-shot LLM invocations

interface OneShotResult { content: string; costUsd: number; model: string; }

function runOneShotClaude(
  prompt: string,
  spawnEnvOverrides: Record<string, string | undefined>,
  projectRoot: string,
): Promise<OneShotResult> {
  return new Promise((resolve, reject) => {
    let bin: string;
    try { bin = resolveClaudeBin(); } catch (err) { reject(err); return; }

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(spawnEnvOverrides)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    // Bypass-root-as-sandbox: same reasoning as agent runs (see claude-cli).
    env.IS_SANDBOX = "1";

    // Cheap model (haiku) for cards. No --max-budget-usd: tool-using
    // exploration (Read/Glob/Bash) routinely needs >$0.05 across 10+ turns
    // when the project is non-trivial; the budget cap caused decisions/style
    // cards to fail with error_max_budget_usd. Haiku still keeps the real
    // spend at a few cents per card.
    //
    // `bypassPermissions` is required for headless --print so tool calls
    // (Read/Glob/Grep/Bash) actually fire instead of being auto-denied —
    // without it haiku replies "I don't have access to the filesystem".
    // `--disallowedTools` keeps the run read-only: a summary task should
    // never mutate the project.
    const args = [
      "--print",
      "--output-format", "json",
      "--model", "haiku",
      "--permission-mode", "bypassPermissions",
      "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit",
    ];
    const child = spawn(bin, args, { env, cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as {
          result?: string;
          is_error?: boolean;
          total_cost_usd?: number;
          modelUsage?: Record<string, unknown>;
        };
        if (parsed.is_error) {
          reject(new Error(`claude reported is_error: ${String(parsed.result).slice(0, 300)}`));
          return;
        }
        const model = Object.keys(parsed.modelUsage ?? {})[0] ?? "claude-haiku";
        resolve({
          content: parsed.result ?? "",
          costUsd: parsed.total_cost_usd ?? 0,
          model,
        });
      } catch (err) {
        reject(new Error(`claude returned non-JSON output: ${(err as Error).message}; raw=${stdout.slice(0, 200)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

function runOneShotCodex(
  prompt: string,
  spawnEnvOverrides: Record<string, string | undefined>,
  projectRoot: string,
): Promise<OneShotResult> {
  return new Promise((resolve, reject) => {
    let bin: string;
    try { bin = resolveCodexBin(); } catch (err) { reject(err); return; }

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(spawnEnvOverrides)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }

    // No --model: chatgpt subscriptions reject every named model. The
    // CLI uses the account default. API-key users get whatever the
    // default is too — fine for a one-shot summary.
    const args = [
      "exec", "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--ephemeral",
    ];
    const child = spawn(bin, args, { env, cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`codex exited ${code}: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`));
        return;
      }
      // Codex --json emits one JSON line per event; the assistant text lands
      // on item.completed with type=agent_message. Cost is zero on
      // ChatGPT subscriptions.
      const lines = stdout.split("\n").filter(Boolean);
      let content = "";
      let model = "codex-default";
      for (const line of lines) {
        try {
          const evt = JSON.parse(line) as {
            type?: string;
            item?: { type?: string; text?: string };
            usage?: unknown;
          };
          if (evt.type === "item.completed" && evt.item?.type === "agent_message") {
            content = evt.item.text ?? "";
          }
        } catch { /* skip non-JSON lines */ }
      }
      if (!content) {
        reject(new Error(`codex returned no agent_message; raw=${stdout.slice(0, 300)}`));
        return;
      }
      resolve({ content, costUsd: 0, model });
    });
    child.stdin.end(prompt);
  });
}

/**
 * Cheap-and-cheerful token estimate. For card-budgeting purposes a chars/4
 * heuristic is within ±20% of real tiktoken counts on English prose — good
 * enough for "did we blow the bootstrap budget?" Exported for tests.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
