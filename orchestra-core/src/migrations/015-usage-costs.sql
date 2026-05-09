-- Per-run, per-model cost telemetry.
-- One row inserted per entry in SDK result.modelUsage; aggregate for daily caps,
-- breakdowns, and anomaly detection.

CREATE TABLE IF NOT EXISTS usage_costs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id   UUID REFERENCES sessions(id) ON DELETE SET NULL,
  task_id      UUID REFERENCES tasks(id) ON DELETE SET NULL,
  role         TEXT NOT NULL,
  model        TEXT NOT NULL,
  cost_usd     DOUBLE PRECISION NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  result_subtype TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_costs_project_day ON usage_costs (project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_costs_session ON usage_costs (session_id);
CREATE INDEX IF NOT EXISTS idx_usage_costs_task ON usage_costs (task_id);
