-- Priority for the scheduler. Higher runs first when multiple jobs are due.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_jobs_due;
CREATE INDEX IF NOT EXISTS idx_jobs_due_pri
  ON jobs (priority DESC, run_at ASC)
  WHERE status = 'pending';
