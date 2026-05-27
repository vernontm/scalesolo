-- Content mix — user-chosen distribution of segment types in a video.
--
-- Shape (jsonb):
--   {
--     "avatar_pct":       20,
--     "broll_image_pct":  30,
--     "broll_video_pct":  20,
--     "motion_pct":       30
--   }
-- Sums to 100. Set via the ContentMix step in the new-video survey;
-- the segmentation prompt reads it as a soft constraint when assigning
-- segment_type to each beat.
--
-- jsonb (not separate columns) because:
--   - It travels as a single object in the API body
--   - Future mix dimensions (e.g. "audio_only_pct" if we ever ship a
--     podcast-mode segment type) don't need another migration
--   - NULL means "no mix preference, let Claude decide" (legacy
--     behavior for videos created before this column existed)

alter table public.studio_videos
  add column if not exists content_mix jsonb;
