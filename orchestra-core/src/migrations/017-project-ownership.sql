-- Project ownership + membership.
-- Up to here every authenticated user could see every project. We move to
-- "owner + invited members": a project is visible to its owner and to anyone
-- explicitly added to project_members.
--
-- Backfill picks the first-registered user as owner for any existing
-- ownerless project. On a fresh install with no users yet, owner stays NULL
-- and the next signup performs the backfill (see auth-api.ts).

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects (owner_id);

CREATE TABLE IF NOT EXISTS project_members (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'editor'
             CHECK (role IN ('viewer', 'editor', 'admin')),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON project_members (user_id);

-- One-time backfill: existing projects get the oldest user as owner.
-- Idempotent because we only touch rows where owner_id IS NULL.
DO $$
DECLARE
  first_user UUID;
BEGIN
  SELECT id INTO first_user FROM users ORDER BY created_at ASC LIMIT 1;
  IF first_user IS NOT NULL THEN
    UPDATE projects SET owner_id = first_user WHERE owner_id IS NULL;
  END IF;
END $$;
