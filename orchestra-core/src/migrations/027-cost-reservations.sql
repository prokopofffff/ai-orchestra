-- Cost reservations: worst-case per-run budget held for an in-flight agent so
-- concurrent spawns can't all pass the daily cap check and then collectively
-- overshoot it. Actual spend lands in usage_costs only after a run finishes,
-- so without a reservation the pre-spawn cap read is blind to runs already
-- launched-but-not-yet-billed. A row is inserted atomically at spawn time
-- (under a global advisory lock, alongside the cap check) and deleted when the
-- run ends. Cap math = SUM(usage_costs) + SUM(cost_reservations); reporting
-- (breakdown / series) reads usage_costs only, so estimates never pollute it.
CREATE TABLE IF NOT EXISTS cost_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  estimated_usd double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cost_reservations_project ON cost_reservations (project_id);
CREATE INDEX IF NOT EXISTS idx_cost_reservations_created_at ON cost_reservations (created_at);
CREATE INDEX IF NOT EXISTS idx_cost_reservations_session ON cost_reservations (session_id);
