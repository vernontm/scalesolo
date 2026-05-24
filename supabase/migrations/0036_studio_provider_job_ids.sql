-- Studio asset orchestration needs to remember the provider's job id
-- for each async operation. Kie.ai images and HeyGen avatar videos both
-- return a task/video id at submission time, and the poller has to look
-- the same id back up to find out when the asset is ready.
--
-- ElevenLabs is synchronous (we get the mp3 bytes back in the same call),
-- so no column needed there — voice_url is filled directly.
alter table public.studio_segments
  add column if not exists kie_task_id text,
  add column if not exists heygen_video_id text;

create index if not exists studio_segments_kie_task_idx
  on public.studio_segments (kie_task_id)
  where kie_task_id is not null;
create index if not exists studio_segments_heygen_video_idx
  on public.studio_segments (heygen_video_id)
  where heygen_video_id is not null;
