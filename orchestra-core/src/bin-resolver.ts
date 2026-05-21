import { existsSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Resolve absolute path for a CLI binary the orchestra spawns (claude, codex).
 *
 * Why this exists: when orchestra-core is started from a non-login shell
 * (system service, IDE task runner, Docker), `PATH` often misses the
 * directories where global Node CLIs land — e.g. `/opt/homebrew/bin`,
 * `~/.local/bin`, `~/.bun/bin`. A bare `spawn("codex")` then fails with
 * `ENOENT` even though `which codex` works for the user in their terminal.
 *
 * Resolution order:
 *   1. Explicit env override (`CODEX_CLI_BIN` / `CLAUDE_CLI_BIN`)
 *   2. Anything on `PATH` that's executable (covered by spawn's default)
 *   3. Common install locations probed by absolute path
 *
 * Returns the bare name if found via PATH, an absolute path if found via
 * the fallback search, or throws a Russian-language error with concrete
 * remediation if nothing resolves.
 */

const COMMON_DIRS = (): string[] => {
  const home = os.homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".npm-global/bin"),
    path.join(home, ".nvm/versions/node"),
  ];
};

function isExecutable(p: string): boolean {
  try {
    const s = statSync(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Walk PATH ourselves so we get a real boolean instead of relying on spawn's lazy lookup. */
function findOnPath(name: string): string | null {
  const PATH = process.env.PATH ?? "";
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function findInCommonDirs(name: string): string | null {
  for (const dir of COMMON_DIRS()) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

const cache = new Map<string, string>();

export type ResolveBinOptions = {
  /** The binary name expected on PATH, e.g. "codex" or "claude". */
  name: string;
  /** Optional env override (its value is used verbatim if non-empty). */
  envOverride?: string;
  /** Russian-friendly install hint shown in the error. */
  installHint: string;
};

export function resolveBin(opts: ResolveBinOptions): string {
  const cacheKey = `${opts.name}::${opts.envOverride ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // 1. Explicit override wins, even if the file doesn't exist — surface a
  //    crisp error rather than silently falling through.
  if (opts.envOverride && opts.envOverride.length > 0) {
    if (!isExecutable(opts.envOverride)) {
      throw new Error(
        `Указанный в переменной окружения путь к ${opts.name} не существует или не исполняемый: ${opts.envOverride}`,
      );
    }
    cache.set(cacheKey, opts.envOverride);
    return opts.envOverride;
  }

  // 2. PATH lookup — most common success path.
  const onPath = findOnPath(opts.name);
  if (onPath) {
    cache.set(cacheKey, onPath);
    return onPath;
  }

  // 3. Common install dirs — covers Homebrew, npm global, bun, pip-style.
  const common = findInCommonDirs(opts.name);
  if (common) {
    cache.set(cacheKey, common);
    return common;
  }

  throw new Error(
    `Не удалось найти ${opts.name} в PATH. ${opts.installHint}`,
  );
}

/** Clear the cache — exposed for tests. */
export function _resetBinCache(): void {
  cache.clear();
}

export const CLAUDE_INSTALL_HINT =
  "Установите CLI: `npm i -g @anthropic-ai/claude-code` или укажите путь в переменной CLAUDE_CLI_BIN.";
export const CODEX_INSTALL_HINT =
  "Установите CLI: `npm i -g @openai/codex` или укажите путь в переменной CODEX_CLI_BIN.";

export function resolveClaudeBin(): string {
  return resolveBin({
    name: "claude",
    envOverride: process.env.CLAUDE_CLI_BIN,
    installHint: CLAUDE_INSTALL_HINT,
  });
}

export function resolveCodexBin(): string {
  return resolveBin({
    name: "codex",
    envOverride: process.env.CODEX_CLI_BIN,
    installHint: CODEX_INSTALL_HINT,
  });
}
