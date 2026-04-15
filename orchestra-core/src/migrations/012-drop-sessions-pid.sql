-- Agents run via the Agent SDK now (no per-agent subprocess to track from
-- this side). The pid column was always orchestrator pid post-migration,
-- carrying no information. Drop it.
ALTER TABLE sessions DROP COLUMN IF EXISTS pid;
