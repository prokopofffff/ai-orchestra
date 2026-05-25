import fs from "node:fs";
import path from "node:path";
import { encryptSecret, decryptSecret } from "./secrets";
import { getPool } from "./db";
import { defaultRepoDir } from "./repo-manager";
import { getUserWorkspaceRoot, isPathInUserScope } from "./workspace-scope";
import { log } from "./obs";

/**
 * Project-settings helpers for the encrypted-at-rest lifecycle of every
 * per-project secret orchestra stores (git PAT, Claude API key, Codex API
 * key). All three follow the same shape:
 *
 *   settings.provider.token         ←→  settings.provider.tokenEncrypted
 *   settings.claude.apiKey          ←→  settings.claude.apiKeyEncrypted
 *   settings.codex.apiKey           ←→  settings.codex.apiKeyEncrypted
 *
 * The plaintext-named field is wire-format ONLY: accepted on PATCH from the
 * dashboard, encrypted in flight by `normalizeProjectSecretsForWrite`, and
 * stored exclusively in the `…Encrypted` field. Reads go through the per-
 * secret `getProjectXxxApiKey` helpers (lazy decrypt). The dashboard never
 * sees plaintext back — `tokenEncrypted` / `apiKeyEncrypted` are opaque to
 * it and only drive UX state ("token is set / not set").
 *
 * Boot-time `migratePlaintextProjectSecrets` walks every project once and
 * encrypts any leftover plaintext, keeping pre-encryption installs working
 * after upgrade.
 */

type EncryptablePair = {
  plain: "token" | "apiKey";
  encrypted: "tokenEncrypted" | "apiKeyEncrypted";
};

const SECRET_BUCKETS: { key: "provider" | "claude" | "codex"; pair: EncryptablePair }[] = [
  { key: "provider", pair: { plain: "token", encrypted: "tokenEncrypted" } },
  { key: "claude", pair: { plain: "apiKey", encrypted: "apiKeyEncrypted" } },
  { key: "codex", pair: { plain: "apiKey", encrypted: "apiKeyEncrypted" } },
];

/** Decrypt-or-fallback common to all three secret shapes. */
function readSecret(bucket: Record<string, unknown> | undefined, pair: EncryptablePair): string | null {
  if (!bucket) return null;
  const enc = bucket[pair.encrypted];
  if (typeof enc === "string" && enc.length > 0) return decryptSecret(enc);
  // Legacy plaintext fallback — unreachable post-migration but keeps a
  // freshly-saved project working during the upgrade window.
  const plain = bucket[pair.plain];
  if (typeof plain === "string" && plain.length > 0) return plain;
  return null;
}

export function getProjectGitToken(settings: unknown): string | null {
  const s = (settings as { provider?: Record<string, unknown> } | null | undefined);
  return readSecret(s?.provider, { plain: "token", encrypted: "tokenEncrypted" });
}

export function getProjectClaudeApiKey(settings: unknown): string | null {
  const s = (settings as { claude?: Record<string, unknown> } | null | undefined);
  return readSecret(s?.claude, { plain: "apiKey", encrypted: "apiKeyEncrypted" });
}

export function getProjectCodexApiKey(settings: unknown): string | null {
  const s = (settings as { codex?: Record<string, unknown> } | null | undefined);
  return readSecret(s?.codex, { plain: "apiKey", encrypted: "apiKeyEncrypted" });
}

/**
 * Reshape a PATCH-incoming settings object: encrypt any plaintext token /
 * apiKey across all three known buckets, rewriting them under the matching
 * `…Encrypted` field before the payload hits the DB.
 *
 * Idempotent: payloads that already carry only the encrypted form pass
 * through. Empty / null / undefined plaintext clears BOTH plain + encrypted
 * fields (= "user explicitly removed this secret").
 */
export function normalizeProjectSecretsForWrite<T extends Record<string, unknown>>(settings: T): T {
  let next = settings;
  for (const { key, pair } of SECRET_BUCKETS) {
    const bucket = (next as Record<string, unknown>)[key];
    if (!bucket || typeof bucket !== "object") continue;
    const before = bucket as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(before, pair.plain)) continue;

    const cleaned: Record<string, unknown> = { ...before };
    const raw = before[pair.plain];
    if (typeof raw === "string" && raw.trim().length > 0) {
      cleaned[pair.encrypted] = encryptSecret(raw.trim());
    } else {
      // Empty / null / undefined plaintext → user is clearing the secret.
      delete cleaned[pair.encrypted];
    }
    delete cleaned[pair.plain];
    next = { ...(next as Record<string, unknown>), [key]: cleaned } as T;
  }
  return next;
}

/**
 * Back-compat alias — the original encryption only covered the git PAT and
 * callers around the codebase still reference the old name. Re-exported so
 * task-api.ts compiles without per-callsite churn.
 */
export const normalizeProviderSecretsForWrite = normalizeProjectSecretsForWrite;

/**
 * Boot-time data migration: encrypt any remaining plaintext secrets across
 * all projects (git PAT + claude.apiKey + codex.apiKey). One SELECT covers
 * every affected row, one UPDATE per row. Idempotent — rows that have only
 * the encrypted form are filtered out by the WHERE clause.
 *
 * Surfaces one log line per project so the operator can see what got
 * migrated; never logs the secret value itself.
 */
export async function migratePlaintextProjectSecrets(): Promise<void> {
  const pool = getPool();
  let rows: { id: string; settings: Record<string, unknown> }[];
  try {
    const res = await pool.query<{ id: string; settings: Record<string, unknown> }>(
      // jsonb '?' is "key exists" — matches any project still carrying a
      // plaintext field in any of the three buckets.
      `SELECT id, settings FROM projects
        WHERE settings->'provider' ? 'token'
           OR settings->'claude' ? 'apiKey'
           OR settings->'codex' ? 'apiKey'`,
    );
    rows = res.rows;
  } catch (err) {
    log.warn({ err }, "migratePlaintextProjectSecrets: skipped (projects table missing?)");
    return;
  }

  for (const row of rows) {
    try {
      const next = normalizeProjectSecretsForWrite(row.settings);
      await pool.query(
        "UPDATE projects SET settings = $1, updated_at = now() WHERE id = $2",
        [next, row.id],
      );
      log.info({ projectId: row.id }, "migrated plaintext project secrets to encrypted storage");
    } catch (err) {
      log.error({ err, projectId: row.id }, "failed to migrate plaintext project secrets");
    }
  }
}

/** Back-compat alias — caller in index.ts. */
export const migratePlaintextProjectTokens = migratePlaintextProjectSecrets;

/**
 * Boot-time data migration: relocate legacy project repos that live at
 * `<workspaces_root>/<slug>/repo` into the new per-user scope at
 * `<workspaces_root>/<ownerId>/<slug>`. The slug dir IS the repo — no
 * nested `repo` subfolder under the new layout. Without this, projects created
 * before the multi-tenant rework stay invisible to FolderPicker (which
 * clamps to the requesting user's subtree) and refuse PATCH updates that
 * touch `local_path` (which now scope-checks).
 *
 * Behaviour:
 * - Skips projects without `owner_id` (no user to scope to — logged).
 * - Skips projects whose `local_path` already lives inside owner scope.
 * - Skips when the source dir doesn't exist on disk (legacy row with
 *   never-cloned repo — `ensureRepo` will create it later in the right
 *   place via the new flow).
 * - Skips when the destination already exists (conflict — needs operator
 *   attention, logged).
 *
 * The move is `fs.rename` (atomic on same filesystem) with an EXDEV
 * fallback to copy-then-delete so a workspaces volume mounted on a
 * different fs than the source still works. The DB update only fires
 * AFTER the on-disk move succeeds, so a half-completed migration leaves
 * a consistent (old-path) row instead of pointing at a destination that
 * may not have all the files.
 *
 * Note: git worktrees attached to the old location are left to be pruned
 * lazily at the next agent spawn — `createWorktree` already does that.
 */
export async function migrateLegacyReposToUserScope(): Promise<void> {
  const pool = getPool();
  let rows: { id: string; slug: string; ownerId: string | null; localPath: string | null }[];
  try {
    const res = await pool.query<{
      id: string;
      slug: string;
      owner_id: string | null;
      local_path: string | null;
    }>(
      `SELECT id, slug, owner_id, local_path FROM projects
        WHERE local_path IS NOT NULL`,
    );
    rows = res.rows.map((r) => ({ id: r.id, slug: r.slug, ownerId: r.owner_id, localPath: r.local_path }));
  } catch (err) {
    log.warn({ err }, "migrateLegacyReposToUserScope: skipped (projects table missing?)");
    return;
  }

  for (const row of rows) {
    if (!row.ownerId) {
      log.warn({ projectId: row.id, slug: row.slug }, "migrateLegacyReposToUserScope: project has no owner — skipped");
      continue;
    }
    if (!row.localPath) continue;
    const src = path.resolve(row.localPath);
    if (isPathInUserScope(row.ownerId, src)) continue; // already inside owner scope
    if (!fs.existsSync(src)) {
      log.info(
        { projectId: row.id, slug: row.slug, src },
        "migrateLegacyReposToUserScope: source missing — nothing to move",
      );
      continue;
    }
    const dst = path.join(getUserWorkspaceRoot(row.ownerId), row.slug);
    if (fs.existsSync(dst)) {
      log.error(
        { projectId: row.id, slug: row.slug, src, dst },
        "migrateLegacyReposToUserScope: destination already exists — manual intervention needed",
      );
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    } catch (err) {
      log.error({ err, projectId: row.id, slug: row.slug, dst }, "migrateLegacyReposToUserScope: mkdir failed");
      continue;
    }

    try {
      fs.renameSync(src, dst);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EXDEV") {
        // Cross-device — workspaces volume on a different fs than the
        // legacy clone location. Fall back to copy + delete.
        try {
          fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true });
          fs.rmSync(src, { recursive: true, force: true });
        } catch (cpErr) {
          log.error(
            { err: cpErr, projectId: row.id, slug: row.slug, src, dst },
            "migrateLegacyReposToUserScope: cp-fallback failed",
          );
          continue;
        }
      } else {
        log.error(
          { err, projectId: row.id, slug: row.slug, src, dst },
          "migrateLegacyReposToUserScope: rename failed",
        );
        continue;
      }
    }

    try {
      await pool.query(
        "UPDATE projects SET local_path = $1, updated_at = now() WHERE id = $2",
        [dst, row.id],
      );
      log.info(
        { projectId: row.id, slug: row.slug, src, dst },
        "moved legacy repo into per-user workspace scope",
      );
    } catch (err) {
      // Files moved but DB update failed — orchestrator will recover on
      // next boot (idempotent: source is gone, destination present at dst).
      // Manual fix: UPDATE projects SET local_path = <dst> WHERE id = <id>.
      log.error(
        { err, projectId: row.id, slug: row.slug, dst },
        "migrateLegacyReposToUserScope: files moved but DB update failed — local_path needs manual fix",
      );
    }
  }
}

/**
 * Boot-time data migration: backfill `local_path` for projects that have
 * a `repo_url` but no path. Pre-refactor, orchestra always cloned to the
 * auto-derived `<workspaces_root>/<slug>/repo` and never recorded that in
 * the row — so on the new "clone into local_path" model the row would
 * look like "no checkout exists" even though the files are sitting there.
 *
 * Pure DB update: no files are moved. The legacy path the row now points
 * at is exactly where the existing clone lives.
 */
export async function backfillLegacyLocalPaths(): Promise<void> {
  const pool = getPool();
  let rows: { id: string; slug: string }[];
  try {
    const res = await pool.query<{ id: string; slug: string }>(
      "SELECT id, slug FROM projects WHERE local_path IS NULL AND repo_url IS NOT NULL",
    );
    rows = res.rows;
  } catch (err) {
    log.warn({ err }, "backfillLegacyLocalPaths: skipped (projects table missing?)");
    return;
  }
  for (const row of rows) {
    const derived = defaultRepoDir(row.slug);
    try {
      await pool.query(
        "UPDATE projects SET local_path = $1, updated_at = now() WHERE id = $2",
        [derived, row.id],
      );
      log.info({ projectId: row.id, localPath: derived }, "backfilled legacy local_path");
    } catch (err) {
      log.error({ err, projectId: row.id }, "failed to backfill local_path");
    }
  }
}
