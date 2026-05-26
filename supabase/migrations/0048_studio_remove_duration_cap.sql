-- Drop the 5-minute upper cap on studio_videos.target_duration_secs.
--
-- Original constraint:
--   CHECK (target_duration_secs >= 30 AND target_duration_secs <= 300)
--
-- The 300s ceiling was a v0 guardrail. In practice scripts and
-- uploaded voiceovers regularly exceed 5 minutes (Ray hit it with a
-- 584s voiceover), and we want the studio to ship whatever the script
-- actually needs. Keeping the 30s floor as a sanity check; everything
-- above it is allowed.
--
-- A row that uploads a voiceover sets target_duration_secs to the
-- transcribed length, which can be 10+ minutes. The render worker
-- already handles long videos correctly (just takes longer); the DB
-- check was the only blocker.

alter table public.studio_videos
  drop constraint if exists studio_videos_target_duration_secs_check;

alter table public.studio_videos
  add constraint studio_videos_target_duration_secs_check
  check (target_duration_secs >= 30);
