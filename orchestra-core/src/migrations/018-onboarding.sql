-- Onboarding state: a single nullable timestamp tracks whether the user
-- has dismissed the welcome flow. Per-step completion is computed live
-- from real state (project count, system_config keys, project settings),
-- so there's no out-of-sync risk between "I clicked the button" and "the
-- thing is actually configured".

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_dismissed_at TIMESTAMPTZ;
