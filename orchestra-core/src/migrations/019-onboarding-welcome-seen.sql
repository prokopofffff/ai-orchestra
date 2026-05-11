-- Welcome modal vs checklist dismissal are now separate. The dismiss
-- button on the checklist shouldn't suppress the welcome (it could fire
-- before the user has even seen it), and closing the welcome shouldn't
-- nuke the checklist (the user just acknowledged the intro, they still
-- need the next-step list). One timestamp per concern.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_welcome_seen_at TIMESTAMPTZ;
