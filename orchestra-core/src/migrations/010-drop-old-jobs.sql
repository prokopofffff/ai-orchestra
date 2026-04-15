-- graphile-worker owns its own schema (`graphile_worker.*`); our hand-rolled
-- `jobs` table is no longer used. Drop it. Keep `rate_buckets` — we still
-- use it for token-bucket gating via graphile-worker's flags/forbiddenFlags.
DROP TABLE IF EXISTS jobs;
