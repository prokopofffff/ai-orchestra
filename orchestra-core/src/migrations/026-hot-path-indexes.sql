-- Hot-path indexes surfaced by the architecture review.
--
-- 1. Org-wide daily cost aggregation (cost-tracker.getOrchestraDailyCost)
--    scans usage_costs by created_at alone. The existing composite
--    idx_usage_costs_project_day (project_id, created_at) can't serve a
--    project-agnostic created_at range, so this query full-scanned the
--    table on every spawn. A created_at index makes the range cheap.
CREATE INDEX IF NOT EXISTS idx_usage_costs_created_at ON usage_costs (created_at);

-- 2. Signal inbox lookups filter by (project_id, to_role, read). The three
--    single-column indexes forced a bitmap-AND or a scan; a composite keyed
--    to the actual predicate serves the unread-by-role query directly.
CREATE INDEX IF NOT EXISTS idx_signals_project_role_read ON signals (project_id, to_role, read);
