-- Move Telegram from global ENV to per-project settings. Each project gets
-- its own bot token + bound chat. A single bot cannot be shared across
-- projects (Telegram's getUpdates long-poll deduplicates updates to one
-- listener anyway, so two projects with the same token would lose half
-- the messages each).
--
-- The config itself lives in projects.settings.telegram as
-- { botToken, chatId } — consistent with provider / models / limits.
-- This migration only guards uniqueness in the data layer; the app
-- also rejects duplicates at write time with a friendlier 409 error.

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_telegram_bot_token
  ON projects ((settings -> 'telegram' ->> 'botToken'))
  WHERE settings -> 'telegram' ->> 'botToken' IS NOT NULL;
