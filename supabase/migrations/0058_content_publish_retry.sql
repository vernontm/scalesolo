-- Auto-retry bookkeeping for failed publishes. The sync cron calls
-- Upload-Post's POST /api/uploadposts/retry (retries only failed
-- platforms, reuses original media) with exponential backoff until the
-- post lands or the budget (6 attempts over ~36h) is exhausted. The
-- long tail covers TikTok's daily active-user cap, which resets 24h out.

ALTER TABLE content_scripts
  ADD COLUMN IF NOT EXISTS publish_retry_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS publish_next_retry_at TIMESTAMPTZ;

COMMENT ON COLUMN content_scripts.publish_retry_count IS
  'How many times the sync cron has called Upload-Post retry for this row. Capped at 6; then the row is marked failed for good.';
COMMENT ON COLUMN content_scripts.publish_next_retry_at IS
  'When the next automatic retry may fire (backoff: 10m/30m/1h/3h/8h/24h). NULL = no retry pending.';

CREATE INDEX IF NOT EXISTS content_scripts_retry_due
  ON content_scripts (publish_next_retry_at)
  WHERE publish_next_retry_at IS NOT NULL;
