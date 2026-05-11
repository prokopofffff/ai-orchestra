-- Project-level memory the orchestrator accumulates over time.
-- First inhabitant: `intro_summary` — what Tech Lead found when it scanned
-- the codebase for the first time (language, framework, build/test tools,
-- conventions, suggested check commands). Future kinds we anticipate:
-- `decision`, `architecture_note`, `learned_convention`. The `kind` is
-- intentionally a free-form text rather than an enum so we can grow without
-- a migration each time.

CREATE TABLE IF NOT EXISTS project_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  body        TEXT NOT NULL,
  author      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_notes_project_kind
  ON project_notes (project_id, kind);

-- Marker on the project so we can find "the intro task" later without
-- fragile title-matching. Nullable: legacy projects predate this feature
-- and won't have an intro task at all.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS intro_task_id UUID
  REFERENCES tasks(id) ON DELETE SET NULL;
