-- Per-brand default posting platforms. When a new post is created for a
-- brand without explicit platforms (MCP upload, calendar drag-to-schedule,
-- the app uploader), it defaults to these instead of "all connected".
-- NULL/empty = fall back to all connected platforms (prior behavior).
-- Stored in the system's canonical platform names (use 'x', not 'twitter').

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS default_platforms TEXT[];

COMMENT ON COLUMN profiles.default_platforms IS
  'Default social platforms a new post for this brand targets when none are specified. NULL/empty = all connected. Canonical names (x, not twitter).';
