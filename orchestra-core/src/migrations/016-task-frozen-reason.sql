-- Generic "this task is paused due to a safety cap" marker.
-- Non-NULL = dispatcher refuses to spawn agents for it. Set by revisions cap,
-- failed-loop cap, per-run budget breach, etc. Cleared via /tasks/:id/unfreeze.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS frozen_reason TEXT;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS revisions_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS failed_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS signals_count INTEGER NOT NULL DEFAULT 0;
