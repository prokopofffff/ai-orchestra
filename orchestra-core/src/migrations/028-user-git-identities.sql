-- Per-user OAuth identities for git providers (GitHub / GitLab).
--
-- This is the "Connect account" half of the one-button auth UX: instead of
-- pasting a PAT, the user authorizes orchestra via the provider's OAuth flow
-- and we store the resulting user-access token here, encrypted at rest. The
-- token is used to attribute PRs/commits to the human (and, for GitLab, also
-- serves as the repo-access credential since GitLab has no app-install model).
--
-- One row per (user, provider). access_token / refresh_token hold base64
-- AES-GCM ciphertext (see secrets.ts) — never plaintext. expires_at is NULL
-- for non-expiring tokens (classic GitHub user tokens); GitLab tokens and
-- GitHub tokens minted with expiry get refreshed via refresh_token.
CREATE TABLE IF NOT EXISTS user_git_identities (
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                TEXT NOT NULL,
  external_login          TEXT,
  external_id             TEXT,
  access_token_encrypted  TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  expires_at              TIMESTAMPTZ,
  scopes                  TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider),
  CONSTRAINT user_git_identities_provider_check CHECK (provider IN ('github', 'gitlab'))
);
