-- Per-project context cards: pre-computed summaries that orchestra inlines
-- into the bootstrap prompts of OTHER projects that reference this one
-- (Phase 3 of the cross-project-context plan). Without this, every linked
-- project has to re-discover the same architecture/style/decisions each
-- spawn — wasteful in tokens and inconsistent across runs.
--
-- `kind` is intentionally text rather than an enum so kinds can grow
-- without a migration. The four canonical kinds at v1 are:
--   architecture     — tech stack, entry points, key directories
--   decisions        — design decisions worth carrying across projects
--   style            — naming/format/UI conventions
--   recent_activity  — last commits + closed tasks summary
--
-- UNIQUE (project_id, kind) — regenerate UPSERTs in place rather than
-- accumulating versions; old content is irretrievable but git history
-- carries enough context to re-derive if ever needed.
--
-- source_sha pins the card to a specific git HEAD so the regenerate
-- endpoint can short-circuit when nothing has changed since the last run.
-- token_count + cost_usd let the dashboard surface "what this card costs
-- you" without re-tokenizing the body every render.

CREATE TABLE IF NOT EXISTS project_context_cards (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind            TEXT        NOT NULL,
  content         TEXT        NOT NULL,
  token_count     INTEGER     NOT NULL DEFAULT 0,
  source_sha      TEXT,
  generator_model TEXT,
  cost_usd        NUMERIC(10, 6) NOT NULL DEFAULT 0,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_project_context_cards_project
  ON project_context_cards (project_id);
