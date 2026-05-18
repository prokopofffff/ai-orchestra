-- system_config is shared across all users. Credentials stored here were
-- silently being used by every project regardless of which user created it
-- — a cross-user leak. Per-project settings.claude.apiKey and
-- settings.provider.token are the only credential sources going forward.
-- Drop the dead rows so we don't hold those secrets after the code stops
-- reading them.
DELETE FROM system_config WHERE key IN ('claude_api_key', 'github_token');
