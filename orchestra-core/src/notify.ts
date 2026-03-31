import { z } from "zod";
import { OrchestraConfig } from "./config.js";

export const NotifyPayloadSchema = z.object({
  channel: z.string().default("telegram"),
  message: z.string().min(1),
  chatId: z.string().optional(),
});
export type NotifyPayload = z.infer<typeof NotifyPayloadSchema>;

export async function notifyUser(
  config: OrchestraConfig,
  message?: string
): Promise<boolean> {
  if (!message) return false;

  const sent = await sendViaOpenClaw(config.openclaw.url, message);
  if (sent) return true;

  // Fallback: log to console
  console.log(`[NOTIFY USER]: ${message}`);
  return false;
}

/**
 * Send a message mirroring agent communication to the user.
 * Used by Signal Router to keep user informed of agent activity.
 */
export async function mirrorToUser(
  config: OrchestraConfig,
  from: string,
  to: string,
  action: string,
  message?: string
): Promise<boolean> {
  const formatted = `[${from} → ${to}] ${action}${message ? `: ${message}` : ""}`;
  return sendViaOpenClaw(config.openclaw.url, formatted);
}

async function sendViaOpenClaw(
  openclawUrl: string,
  message: string
): Promise<boolean> {
  try {
    const payload = NotifyPayloadSchema.parse({
      channel: "telegram",
      message,
    });

    const response = await fetch(`${openclawUrl}/api/send`, {
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
