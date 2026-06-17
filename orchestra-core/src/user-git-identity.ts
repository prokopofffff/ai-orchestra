import { and, eq, sql } from "drizzle-orm";
import type { GitProviderKind } from "@ai-orchestra/shared";
import { getDb } from "./db";
import { userGitIdentities } from "./db/schema";
import { encryptSecret, decryptSecret } from "./secrets";
import {
  refreshGitLabToken, refreshGitHubToken,
  type OAuthTokenSet,
} from "./git-app";
import { log } from "./obs";

/**
 * Persistence + freshness for per-user git OAuth identities (the "Connect
 * account" credential). Tokens are encrypted at rest; the only way out of
 * this module is `getValidUserToken`, which transparently refreshes an
 * expired token before handing it back.
 */

export interface GitIdentitySummary {
  provider: GitProviderKind;
  login: string | null;
  connectedAt: string;
}

/** Upsert a fresh OAuth token set for (user, provider). */
export async function saveUserGitIdentity(
  userId: string,
  provider: GitProviderKind,
  tokens: OAuthTokenSet,
  user: { login: string; id: string },
): Promise<void> {
  const accessTokenEncrypted = encryptSecret(tokens.accessToken);
  const refreshTokenEncrypted = tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null;
  const expiresAt = tokens.expiresAt ? new Date(tokens.expiresAt) : null;

  await getDb()
    .insert(userGitIdentities)
    .values({
      userId,
      provider,
      externalLogin: user.login,
      externalId: user.id,
      accessTokenEncrypted,
      refreshTokenEncrypted,
      expiresAt,
      scopes: tokens.scopes ?? null,
    })
    .onConflictDoUpdate({
      target: [userGitIdentities.userId, userGitIdentities.provider],
      set: {
        externalLogin: user.login,
        externalId: user.id,
        accessTokenEncrypted,
        refreshTokenEncrypted,
        expiresAt,
        scopes: tokens.scopes ?? null,
        updatedAt: sql`now()`,
      },
    });
}

export async function deleteUserGitIdentity(userId: string, provider: GitProviderKind): Promise<void> {
  await getDb()
    .delete(userGitIdentities)
    .where(and(eq(userGitIdentities.userId, userId), eq(userGitIdentities.provider, provider)));
}

/** List a user's connected identities (display-only; never exposes tokens). */
export async function listUserGitIdentities(userId: string): Promise<GitIdentitySummary[]> {
  const rows = await getDb()
    .select({
      provider: userGitIdentities.provider,
      login: userGitIdentities.externalLogin,
      createdAt: userGitIdentities.createdAt,
    })
    .from(userGitIdentities)
    .where(eq(userGitIdentities.userId, userId));
  return rows.map((r) => ({
    provider: r.provider as GitProviderKind,
    login: r.login,
    connectedAt: r.createdAt.toISOString(),
  }));
}

/**
 * Return a usable access token for (user, provider), refreshing it first when
 * it's expired (or within 60s of expiring) and a refresh token is on file.
 * Returns null when the user hasn't connected this provider, or when a
 * refresh was needed but failed (caller falls through to the next credential).
 */
export async function getValidUserToken(
  userId: string,
  provider: GitProviderKind,
): Promise<string | null> {
  const [row] = await getDb()
    .select()
    .from(userGitIdentities)
    .where(and(eq(userGitIdentities.userId, userId), eq(userGitIdentities.provider, provider)))
    .limit(1);
  if (!row) return null;

  const notExpired = !row.expiresAt || row.expiresAt.getTime() - 60_000 > Date.now();
  if (notExpired) {
    try {
      return decryptSecret(row.accessTokenEncrypted);
    } catch (err) {
      log.warn({ err, userId, provider }, "getValidUserToken: decrypt failed (key rotated?)");
      return null;
    }
  }

  // Expired — try to refresh.
  if (!row.refreshTokenEncrypted) {
    log.warn({ userId, provider }, "getValidUserToken: token expired and no refresh token");
    return null;
  }
  try {
    const refreshToken = decryptSecret(row.refreshTokenEncrypted);
    const refreshed = provider === "gitlab"
      ? await refreshGitLabToken(refreshToken)
      : await refreshGitHubToken(refreshToken);
    await getDb()
      .update(userGitIdentities)
      .set({
        accessTokenEncrypted: encryptSecret(refreshed.accessToken),
        refreshTokenEncrypted: refreshed.refreshToken
          ? encryptSecret(refreshed.refreshToken)
          : row.refreshTokenEncrypted,
        expiresAt: refreshed.expiresAt ? new Date(refreshed.expiresAt) : null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(userGitIdentities.userId, userId), eq(userGitIdentities.provider, provider)));
    return refreshed.accessToken;
  } catch (err) {
    log.warn({ err, userId, provider }, "getValidUserToken: refresh failed");
    return null;
  }
}
