-- Paste-a-script flow. When the user pastes a script (rather than
-- describing a topic), we store the verbatim text on the video row.
-- generate-map then uses it as-is and only decides segment boundaries
-- + visual treatments instead of rewriting the script.

ALTER TABLE studio_videos
  ADD COLUMN IF NOT EXISTS fixed_script TEXT;

COMMENT ON COLUMN studio_videos.fixed_script IS
  'User-pasted script. When set, generate-map uses this text verbatim and just decides segment boundaries + visual treatments (no rewriting).';
