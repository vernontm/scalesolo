-- AI Walkthrough videos: a streamlined, lightweight pipeline (separate
-- from Studio). The user picks an avatar photo, a voice, and a topic; we
-- write a short segmented script in the brand voice, generate a HeyGen
-- talking-head, and bake the finished video with HyperFrames (avatar clip
-- layered over branded animated scenes + captions). The result is saved to
-- the Library.
--
-- Deliberately its own table (not studio_videos) so the two pipelines can
-- evolve independently. Reads/writes go through the service key in the API,
-- but RLS mirrors studio_videos so the browser can subscribe to Realtime
-- progress safely.

create table if not exists public.walkthrough_videos (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,

  -- Inputs
  topic text not null,
  title text,
  -- The chosen avatar, resolved to whatever HeyGen needs at gen time.
  -- Shape: { kind: 'avatar'|'default'|'photo',
  --          avatar_id, look_id, default_avatar_id,
  --          heygen_group_id, heygen_look_id, talking_photo_id,
  --          photo_url, thumbnail_url, model_version }
  avatar_ref jsonb not null default '{}'::jsonb,
  voice_id text,                                   -- ElevenLabs voice id
  aspect_ratio text not null default '9:16'
    check (aspect_ratio in ('16:9','9:16','1:1')),

  -- Script: { full_text, hook, cta,
  --           segments: [{ id, kind:'intro'|'point'|'cta',
  --                        heading, narration }] }
  script jsonb,

  -- State machine
  status text not null default 'draft'
    check (status in (
      'draft',        -- created, no script yet
      'scripted',     -- script written, awaiting generate
      'generating',   -- HeyGen avatar + assets in progress
      'rendering',    -- HyperFrames bake in progress on the worker
      'rendered',     -- final_url is live (also saved to Library)
      'failed'
    )),

  -- Outputs / intermediates
  avatar_video_id text,        -- HeyGen video id
  avatar_video_url text,       -- mirrored talking-head clip
  composition_html text,       -- the HyperFrames composition handed to the worker
  final_url text,              -- finished video (Supabase storage)
  content_id uuid references public.content_scripts(id) on delete set null, -- Library row
  credits_used numeric(10,2) not null default 0,

  -- Progress: { stage, current, total, started_at }
  render_progress jsonb,
  error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists walkthrough_videos_profile_idx
  on public.walkthrough_videos (profile_id, created_at desc);
create index if not exists walkthrough_videos_user_idx
  on public.walkthrough_videos (user_id, created_at desc);
create index if not exists walkthrough_videos_status_idx
  on public.walkthrough_videos (status) where status in ('generating','rendering');

comment on table public.walkthrough_videos is
  'AI Walkthrough builder: photo + voice + topic -> HeyGen talking-head baked with HyperFrames over branded animated scenes. Streamlined pipeline separate from studio_videos.';

alter table public.walkthrough_videos enable row level security;

drop policy if exists walkthrough_videos_select on public.walkthrough_videos;
create policy walkthrough_videos_select on public.walkthrough_videos
  for select using (public.has_profile_access(profile_id));

drop policy if exists walkthrough_videos_insert on public.walkthrough_videos;
create policy walkthrough_videos_insert on public.walkthrough_videos
  for insert with check (public.has_profile_access(profile_id));

drop policy if exists walkthrough_videos_update on public.walkthrough_videos;
create policy walkthrough_videos_update on public.walkthrough_videos
  for update using (public.has_profile_access(profile_id));

drop policy if exists walkthrough_videos_delete on public.walkthrough_videos;
create policy walkthrough_videos_delete on public.walkthrough_videos
  for delete using (public.has_profile_access(profile_id));
