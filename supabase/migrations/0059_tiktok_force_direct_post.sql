-- Opt-in per-profile: when TikTok falls back to Inbox (Upload-Post's
-- shared daily active-user cap), the sync cron re-submits the video as
-- a fresh TikTok-only post on a long backoff until it lands on the
-- feed. Off by default — each capped attempt stacks an extra unposted
-- draft in the user's TikTok inbox, so this is for operators who
-- explicitly prefer that trade over tap-publishing.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS tiktok_force_direct_post BOOLEAN NOT NULL DEFAULT false;

-- Tracks the TikTok-only re-submission chain separately from the
-- original multi-platform request so IG/FB post ids stay resolvable
-- on the original uploadpost_request_id.
ALTER TABLE content_scripts
  ADD COLUMN IF NOT EXISTS tiktok_retry_request_id TEXT;

COMMENT ON COLUMN profiles.tiktok_force_direct_post IS
  'When true, the sync cron re-submits TikTok inbox-fallback deliveries as fresh TikTok-only posts (backoff 2h/4h/8h/12h/24h, max 5) until one direct-posts to the feed.';
COMMENT ON COLUMN content_scripts.tiktok_retry_request_id IS
  'Upload-Post request_id of the latest TikTok-only re-submission. NULL = no forced-direct-post chain active.';
