-- Generic job scheduler: replaces scattered setInterval/setTimeout.
-- Lease-based claiming with SKIP LOCKED for multi-worker safety.

CREATE TABLE IF NOT EXISTS rate_buckets (
  key          TEXT PRIMARY KEY,
  tokens       DOUBLE PRECISION NOT NULL,
  capacity     DOUBLE PRECISION NOT NULL,
  refill_rate  DOUBLE PRECISION NOT NULL, -- tokens per second
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id             BIGSERIAL PRIMARY KEY,
  kind           TEXT NOT NULL,               -- handler name
  payload        JSONB NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','done','failed','cancelled')),

  -- Scheduling
  run_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  cron           TEXT,                        -- if set, job is recurring
  cron_key       TEXT UNIQUE,                 -- de-dup recurring definitions

  -- Lease
  locked_until   TIMESTAMPTZ,
  locked_by      TEXT,                        -- worker id

  -- Rate limiting
  bucket_key     TEXT,                        -- references rate_buckets.key

  -- Retries
  attempts       INT NOT NULL DEFAULT 0,
  max_attempts   INT NOT NULL DEFAULT 5,
  last_error     TEXT,

  -- Bookkeeping
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);

-- Hot path: "next due pending job I can claim"
CREATE INDEX IF NOT EXISTS idx_jobs_due
  ON jobs (run_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_jobs_lease
  ON jobs (locked_until)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_jobs_kind_status
  ON jobs (kind, status);
