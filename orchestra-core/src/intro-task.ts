import { getDb } from "./db";
import { tasks } from "./db/schema";
import { background } from "./error-handler";
import { dispatchSignal } from "./dispatcher";
import { loadConfig } from "./config";

/**
 * "Tech Lead, please scan the codebase and report back." Auto-fired the
 * first time a project is created with a repo to look at. The description
 * doubles as the prompt — bootstrap-context puts task.description straight
 * into the system prompt, so anything written here lands in front of TL.
 *
 * Returns the task id so the caller can pin it on `projects.intro_task_id`,
 * which the signal-api uses later to detect "intro just finished" and
 * promote TL's last comment into project_notes.
 */
export const INTRO_TASK_TITLE = "Introduce yourself to this codebase";

const INTRO_TASK_DESCRIPTION = [
  "This is your first task on this project. The user just added it.",
  "",
  "Goal: get oriented so future tasks land in a productive starting state.",
  "",
  "## What to find out",
  "1. Language(s), framework, runtime version (read package.json / pyproject.toml / go.mod / Cargo.toml / etc).",
  "2. Build / test / lint commands (scripts in package.json, Makefile, justfile, taskfile, README).",
  "3. Project layout — top-level directories and what each is for.",
  "4. Existing conventions — code style, naming, test framework, formatter.",
  "5. Whether a `CLAUDE.md` exists (read it — that's existing per-project memory). If not, suggest one.",
  "6. Anything weird, undocumented, or risky an agent should know up front.",
  "",
  "## What to write back",
  "Add a single comment on THIS task containing your summary. Keep it tight (~200-400 words).",
  "Structure suggestion:",
  "",
  "```",
  "**Stack:** <one line — Node 20, TypeScript, Vite, vitest, …>",
  "**Layout:** <top-level dirs in 3-5 lines>",
  "**Build/test:** <commands>",
  "**Conventions:** <2-4 bullets>",
  "**Suggested Agent Checks** (one per role that needs them):",
  "  - frontend: `<command>`",
  "  - backend: `<command>`",
  "  - qa: `<command>`",
  "**Notes:** <anything else worth flagging>",
  "```",
  "",
  "When done, transition this task to `merged` so the user knows you're finished. They'll review and apply the suggested checks if they like them.",
  "",
  "**Don't write any files. Don't open a PR. Don't run lint or tests against the repo — read-only scan + report.**",
].join("\n");

/**
 * Create the intro task and trigger the dispatcher to spawn TL on it.
 * Returns the task id.
 */
export async function createIntroTask(projectId: string): Promise<string> {
  const db = getDb();
  const [task] = await db
    .insert(tasks)
    .values({
      projectId,
      title: INTRO_TASK_TITLE,
      description: INTRO_TASK_DESCRIPTION,
      type: "task",
      state: "described",
      priority: "high",
      assigneeRole: "tech-lead",
    })
    .returning();

  // Kick off TL via a synthetic signal — same path conversation messages
  // take. Doing this in the background so the project-creation HTTP
  // response stays snappy and a slow spawn doesn't 504 the request.
  const config = loadConfig();
  background(
    dispatchSignal(
      {
        from: "system",
        to: "tech-lead",
        action: "task_unblocked",
        projectId,
        taskId: task.id,
      },
      config,
    ),
    "intro-task:dispatch",
    projectId,
  );

  return task.id;
}
