-- Per-tab onboarding tracking. Each entry in the array is a route key
-- (kanban, chat, signals, agents, flow, logs, settings, profile). When a
-- user finishes (or skips) the tour for a tab, the key is appended.
-- Stored as JSONB array rather than separate rows so we can read/update
-- it in a single round-trip from the per-route guard.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_tabs_seen JSONB NOT NULL DEFAULT '[]'::jsonb;
