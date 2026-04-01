import { spawn } from "node:child_process";

export interface UsageInfo {
  percent: number | null;
  status: "ok" | "warning" | "critical" | "unknown";
  lastChecked: string;
  raw: string | null;
}

let cachedUsage: UsageInfo = {
  percent: null,
  status: "unknown",
  lastChecked: new Date().toISOString(),
  raw: null,
};

let intervalId: ReturnType<typeof setInterval> | null = null;

const CHECK_INTERVAL_MS = 5 * 60_000; // every 5 minutes

export function startUsageTracking(): void {
  if (intervalId) return;
  checkUsage(); // immediate first check
  intervalId = setInterval(checkUsage, CHECK_INTERVAL_MS);
  console.log("Usage tracking started (every 5m)");
}

export function stopUsageTracking(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export function getUsage(): UsageInfo {
  return { ...cachedUsage };
}

async function checkUsage(): Promise<void> {
  try {
    const raw = await runCommand("claude", ["usage"]);
    const percent = parseUsagePercent(raw);

    let status: UsageInfo["status"] = "ok";
    if (percent !== null) {
      if (percent >= 95) status = "critical";
      else if (percent >= 80) status = "warning";
    }

    cachedUsage = {
      percent,
      status,
      lastChecked: new Date().toISOString(),
      raw,
    };
  } catch {
    cachedUsage = {
      ...cachedUsage,
      lastChecked: new Date().toISOString(),
    };
  }
}

function parseUsagePercent(output: string): number | null {
  // Try to find percentage in output like "80%" or "80/100" or "used 80 of 100"
  const percentMatch = output.match(/(\d+)%/);
  if (percentMatch) return Number(percentMatch[1]);

  const fractionMatch = output.match(/(\d+)\s*\/\s*(\d+)/);
  if (fractionMatch) {
    return Math.round((Number(fractionMatch[1]) / Number(fractionMatch[2])) * 100);
  }

  return null;
}

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || `Exit code ${code}`));
      else resolve(stdout.trim());
    });
    proc.on("error", reject);
  });
}
