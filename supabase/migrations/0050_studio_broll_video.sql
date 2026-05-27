-- B-roll video columns on studio_segments — used when a segment is
-- meant to play a Grok Imagine Image-to-Video clip instead of a still
-- image with Ken Burns motion.
--
-- Flow:
--   1. generate-assets dispatches Kie's nano-banana-2 to produce a
--      still image as usual → fills image_url.
--   2. If the segment should be a video (signaled by either content_mix
--      or a per-segment flag from segmentation), generate-assets ALSO
--      dispatches Kie's grok-imagine/image-to-video with the still as
--      the input image + the script_text as motion direction. Returns
--      a separate Kie task id (grok_task_id) and we poll for the
--      output video URL → fills broll_video_url.
--   3. Worker renders: if broll_video_url is present, use that as the
--      segment chunk source (no Ken Burns since the video has its own
--      motion). Otherwise fall back to the image + Ken Burns path.
--
-- New columns:
--   broll_video_url     final mp4 URL from Grok Imagine
--   grok_task_id        Kie task id while generation is pending
--   is_video_broll      bool flag set by segmentation when this
--                       voiceover_broll should be a video, not a still

alter table public.studio_segments
  add column if not exists broll_video_url text,
  add column if not exists grok_task_id    text,
  add column if not exists is_video_broll  boolean not null default false;

create index if not exists studio_segments_grok_task_idx
  on public.studio_segments (grok_task_id)
  where grok_task_id is not null;
