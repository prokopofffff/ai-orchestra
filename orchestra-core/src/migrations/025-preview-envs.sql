-- Per-project preview contour state. See docs/PREVIEW_CONTOUR_DESIGN.md.
--
-- One preview per project (UNIQUE project_id). Source-of-truth for both
-- the user-configured fields (dockerfile_path, branch, app_port, env vars,
-- idle timeout) and preview-manager-maintained runtime fields (state,
-- current_commit, last_request_at, last_deployed_at, error_message).
--
-- All secret-bearing columns are encrypted at rest via secrets.ts
-- (AES-256-GCM, single ORCHESTRA_SECRETS_KEY for v1; per-tenant KMS lands
-- with multi-tenant roadmap #4).
--
--   env_vars_encrypted   — whole JSON object {NAME:value} as one blob
--   dind_ca_encrypted    — TLS CA cert (PEM) for the per-project DinD
--   dind_cert_encrypted  — TLS client cert (PEM) used by dockerode
--   dind_key_encrypted   — TLS client key (PEM)
--
-- `state` values, maintained exclusively by preview-manager:
--   stopped   — config exists but nothing is running (initial, or after Stop)
--   building  — preview-manager is currently pulling/building the image
--   running   — app container is up and reachable
--   sleeping  — app container is stopped after idle_timeout, DinD still warm
--   error     — last deploy/wake failed; error_message holds the reason

CREATE TABLE IF NOT EXISTS preview_envs (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            UUID         NOT NULL UNIQUE
                                     REFERENCES projects(id) ON DELETE CASCADE,
  enabled               BOOLEAN      NOT NULL DEFAULT FALSE,

  dockerfile_path       TEXT,
  compose_file_path     TEXT,
  branch                TEXT         NOT NULL DEFAULT 'main',
  app_port              INTEGER      NOT NULL DEFAULT 8080,

  env_vars_encrypted    TEXT,

  idle_timeout_minutes  INTEGER      NOT NULL DEFAULT 120,
  auto_redeploy_on_push BOOLEAN      NOT NULL DEFAULT TRUE,

  state                 TEXT         NOT NULL DEFAULT 'stopped',
  current_commit        TEXT,
  last_request_at       TIMESTAMPTZ,
  last_deployed_at      TIMESTAMPTZ,
  error_message         TEXT,

  dind_ca_encrypted     TEXT,
  dind_cert_encrypted   TEXT,
  dind_key_encrypted    TEXT,

  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT preview_envs_state_check
    CHECK (state IN ('stopped','building','running','sleeping','error')),
  CONSTRAINT preview_envs_port_check
    CHECK (app_port > 0 AND app_port < 65536),
  CONSTRAINT preview_envs_idle_check
    CHECK (idle_timeout_minutes > 0)
);

-- Hot path for the idle-sweeper cron: scan only previews that could
-- transition. Partial index keeps it tiny even with many disabled rows.
CREATE INDEX IF NOT EXISTS idx_preview_envs_active_state
  ON preview_envs (state)
  WHERE state IN ('running', 'sleeping', 'building');
