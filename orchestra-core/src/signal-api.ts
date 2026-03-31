import { Router, Request, Response } from "express";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { SessionManager, AgentRoleSchema } from "./session-manager.js";
import { AgentSpawner } from "./agent-spawner.js";
import { RateLimiter } from "./rate-limiter.js";
import { OrchestraConfig } from "./config.js";
import { notifyUser } from "./notify.js";

export const SignalActionSchema = z.enum([
  "assign_dev",
  "create_design",
  "create_design_system",
  "design_ready",
  "design_system_ready",
  "question",
  "answer",
  "pr_created",
  "tests_passed",
  "pr_approved",
  "pr_changes_requested",
  "pr_review_update",
  "task_done",
  "escalate",
  "deploy",
  "setup_cicd",
  "notify",
  "mirror",
  "push",
]);
export type SignalAction = z.infer<typeof SignalActionSchema>;

export const SignalContextSchema = z
  .object({
    project_id: z.string().optional(),
    task_id: z.union([z.string(), z.number()]).optional(),
    message: z.string().optional(),
    pr_number: z.number().optional(),
    pr_title: z.string().optional(),
    pr_url: z.string().optional(),
    branch: z.string().optional(),
    repo: z.string().optional(),
    review_action: z.string().optional(),
    reviewer: z.string().optional(),
    author: z.string().optional(),
  })
  .passthrough();
export type SignalContext = z.infer<typeof SignalContextSchema>;

export const SendSignalSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  action: z.string().min(1),
  context: SignalContextSchema.optional().default({}),
});

export const DispatchAgentSchema = z.object({
  role: AgentRoleSchema,
  projectId: z.string().min(1),
  taskId: z.string().optional(),
  prompt: z.string().min(1),
  workingDir: z.string().optional(),
});

export const SignalSchema = z.object({
  id: z.string().uuid(),
  from: z.string(),
  to: z.string(),
  action: z.string(),
  context: SignalContextSchema,
  createdAt: z.coerce.date(),
  processed: z.boolean(),
});
export type Signal = z.infer<typeof SignalSchema>;

export function createSignalRouter(
  config: OrchestraConfig,
  sessionManager: SessionManager,
  spawner?: AgentSpawner,
  rateLimiter?: RateLimiter
): Router {
  const router = Router();
  const pool = new Pool({ connectionString: config.databaseUrl });

  // POST /api/signal — send a signal between agents
  router.post("/", async (req: Request, res: Response) => {
    try {
      const parsed = SendSignalSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid signal payload",
          details: parsed.error.issues,
        });
        return;
      }

      const { from, to, action, context } = parsed.data;
      const id = uuidv4();

      // Store signal
      await pool.query(
        `INSERT INTO signal_queue (id, from_agent, to_agent, action, context)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, from, to, action, JSON.stringify(context)]
      );

      // Log to OpenProject if task_id is in context
      if (context.task_id) {
        await logToOpenProject(config, String(context.task_id), {
          from,
          to,
          action,
          message: context.message,
        });
      }

      // Route signal
      if (to === "user") {
        await notifyUser(config, context.message);
        await markProcessed(pool, id);
        res.json({ id, status: "delivered_to_user" });
        return;
      }

      // Forward to n8n for agent session management
      const n8nResult = await forwardToN8n(config, {
        id,
        from,
        to,
        action,
        context,
      });

      await markProcessed(pool, id);
      res.json({ id, status: "routed", n8nResult });
    } catch (err) {
      console.error("Signal error:", err);
      res.status(500).json({ error: "Failed to process signal" });
    }
  });

  // GET /api/signal/pending/:agentRole — get unprocessed signals for an agent
  router.get("/pending/:agentRole", async (req: Request, res: Response) => {
    try {
      const { agentRole } = req.params;
      const result = await pool.query(
        `SELECT * FROM signal_queue
         WHERE to_agent = $1 AND processed = FALSE
         ORDER BY created_at ASC`,
        [agentRole]
      );

      const signals = result.rows.map((row) =>
        SignalSchema.parse({
          id: row.id,
          from: row.from_agent,
          to: row.to_agent,
          action: row.action,
          context: row.context,
          createdAt: row.created_at,
          processed: row.processed,
        })
      );

      res.json(signals);
    } catch (err) {
      console.error("Error fetching pending signals:", err);
      res.status(500).json({ error: "Failed to fetch signals" });
    }
  });

  // GET /api/signal/history — get signal history
  router.get("/history", async (req: Request, res: Response) => {
    try {
      const limit = z.coerce.number().int().positive().default(50).parse(req.query.limit);
      const result = await pool.query(
        `SELECT * FROM signal_queue ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );

      res.json(
        result.rows.map((row) => ({
          id: row.id,
          from: row.from_agent,
          to: row.to_agent,
          action: row.action,
          context: row.context,
          createdAt: row.created_at,
          processed: row.processed,
        }))
      );
    } catch (err) {
      console.error("Error fetching signal history:", err);
      res.status(500).json({ error: "Failed to fetch history" });
    }
  });

  // POST /api/signal/dispatch — dispatch an agent for a task (uses AgentSpawner + RateLimiter)
  router.post("/dispatch", async (req: Request, res: Response) => {
    try {
      const parsed = DispatchAgentSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid dispatch payload",
          details: parsed.error.issues,
        });
        return;
      }

      const { role, projectId, taskId, prompt, workingDir } = parsed.data;

      // Use AgentSpawner if available (preferred path)
      if (spawner && rateLimiter) {
        const canSpawn = await rateLimiter.canSpawn();

        if (!canSpawn) {
          const position = await rateLimiter.enqueue({
            role,
            projectId,
            taskId,
            prompt,
            workingDir,
          });
          res.json({
            status: "queued",
            position,
            role,
            projectId,
            message: "Rate limit reached, task queued",
          });
          return;
        }

        const result = await spawner.spawn({
          role,
          projectId,
          taskId,
          prompt,
          workingDir,
        });

        res.json(result);
        return;
      }

      // Fallback: direct SessionManager launch
      const existing = await sessionManager.shouldResume(role, projectId);

      const session = existing
        ? existing
        : await sessionManager.createSession(role, projectId, taskId);

      sessionManager
        .launchAgent(session, prompt, workingDir || process.cwd())
        .then((result) => {
          console.log(`Agent ${role} (${session.id}) completed. Output: ${result.output.length} chars`);
        })
        .catch((err) => {
          console.error(`Agent ${role} (${session.id}) failed:`, (err as Error).message);
        });

      res.json({
        sessionId: session.id,
        status: existing ? "resumed" : "created",
        role,
        projectId,
      });
    } catch (err) {
      console.error("Dispatch error:", err);
      res.status(500).json({ error: "Failed to dispatch agent" });
    }
  });

  return router;
}

async function markProcessed(pool: Pool, signalId: string): Promise<void> {
  await pool.query(
    `UPDATE signal_queue SET processed = TRUE WHERE id = $1`,
    [signalId]
  );
}

async function forwardToN8n(
  config: OrchestraConfig,
  signal: {
    id: string;
    from: string;
    to: string;
    action: string;
    context: SignalContext;
  }
): Promise<unknown> {
  try {
    const response = await fetch(`${config.n8n.url}/webhook/signal-router`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signal),
    });
    if (!response.ok) {
      console.warn(`n8n webhook returned ${response.status}`);
      return { status: response.status };
    }
    return await response.json();
  } catch (err) {
    console.warn("n8n not reachable, signal queued:", (err as Error).message);
    return { status: "queued" };
  }
}

async function logToOpenProject(
  config: OrchestraConfig,
  taskId: string,
  signal: { from: string; to: string; action: string; message?: string }
): Promise<void> {
  if (!config.openproject.apiKey) return;

  try {
    const comment = `**[${signal.from} → ${signal.to}]** ${signal.action}${signal.message ? `: ${signal.message}` : ""}`;

    await fetch(
      `${config.openproject.url}/api/v3/work_packages/${taskId}/activities`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`apikey:${config.openproject.apiKey}`).toString("base64")}`,
        },
        body: JSON.stringify({
          comment: { raw: comment },
        }),
      }
    );
  } catch (err) {
    console.warn("Failed to log to OpenProject:", (err as Error).message);
  }
}

// notifyUser imported from ./notify.js
