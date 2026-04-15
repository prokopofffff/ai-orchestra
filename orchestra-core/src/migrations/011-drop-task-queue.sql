-- task_queue was a dual-write ledger alongside graphile-worker's jobs. Drop it;
-- retry counters and queue stats now come from graphile_worker.jobs directly.
DROP TABLE IF EXISTS task_queue;
