import { z } from "zod";
import { OrchestraConfig } from "./config.js";

export const NotifyPayloadSchema = z.object({
  channel: z.string().default("telegram"),
  message: z.string().min(1),
  chatId: z.string().optional(),
});
export type NotifyPayload = z.infer<typeof NotifyPayloadSchema>;

const OPENCLAW_URL = process.env.OPENCLAW_URL || "http://localhost:3100";

export async function notifyUser(
  config: OrchestraConfig,
  message?: string
): Promise<boolean> {
  if (!message) return false;

  // Try OpenClaw first
  const openClawSent = await sendViaOpenClaw(message);
  if (openClawSent) return true;

  // Fallback: log to console
  console.log(`[NOTIFY USER]: ${message}`);
  return false;
}

async function sendViaOpenClaw(message: string): Promise<boolean> {
  try {
    const payload = NotifyPayloadSchema.parse({
      channel: "telegram",
      message,
    });

    const response = await fetch(`${OPENCLAW_URL}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      console.log(`Notification sent via OpenClaw: ${message.substring(0, 50)}...`);
      return true;
    }

    console.warn(`OpenClaw returned ${response.status}`);
    return false;
  } catch (err) {
    console.warn("OpenClaw not available:", (err as Error).message);
    return false;
  }
}

/**
 * Send a message mirroring agent communication to the user.
 * Used by Signal Router to keep user informed of agent activity.
 */
export async function mirrorToUser(
  from: string,
  to: string,
  action: string,
  message?: string
): Promise<boolean> {
  const formatted = `[${from} → ${to}] ${action}${message ? `: ${message}` : ""}`;
  return sendViaOpenClaw(formatted);
}
