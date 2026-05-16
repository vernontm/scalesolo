-- profiles.polish_template — one polish config per brand profile, shared
-- between the Spaces "Finish video" node and the bulk-upload "Polish video"
-- toggle so settings stay in sync across both surfaces.
--
-- Shape mirrors video_polish node's initialProps:
--   { title, title_enabled, title_mode, title_topic, title_font, title_color,
--     title_bg_color, title_size, title_bg_padding, title_y_pos, title_uppercase,
--     watermark_position, watermark_size_pct,
--     music_url, music_file_name, music_size_bytes, music_volume, music_fade_secs,
--     captions_enabled, caption_template_id, caption_template_name }
--
-- Empty object means "use the node's built-in defaults" — same fall-through
-- the canvas does today. No NOT NULL constraint so existing rows survive
-- without a backfill.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS polish_template jsonb DEFAULT '{}'::jsonb;

COMMENT ON COLUMN profiles.polish_template IS
  'Per-brand polish settings shared between Spaces video_polish node and bulk-upload Polish toggle. Shape: video_polish initialProps.';
