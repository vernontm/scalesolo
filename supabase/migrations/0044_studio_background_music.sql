-- Background music for studio videos.
--
-- Mode controls how the music bed plays under the voice:
--   'off'        — no music (default)
--   'loop_one'   — loop a single track from profiles.music_tracks until
--                  the video ends. music_track_id points at it.
--   'cycle_all'  — play every track in profiles.music_tracks in order,
--                  loop the playlist if the video is longer.
--
-- Volume is a 0..1 multiplier — defaults to 0.12 (well under voice).
-- The worker applies a 1.5s fade-in + 2s fade-out at the video tail.

alter table public.studio_videos
  add column if not exists music_mode text not null default 'off'
    check (music_mode in ('off', 'loop_one', 'cycle_all'));

alter table public.studio_videos
  add column if not exists music_track_id text;

alter table public.studio_videos
  add column if not exists music_volume numeric(4,3) not null default 0.120
    check (music_volume >= 0 and music_volume <= 1);
