-- Studio v1 — long-form video generation surface.
--
-- Two new tables, additive only. Prod tables stay untouched.
--
--   studio_videos   — one row per long-form video project
--   studio_segments — one row per "video map" row (the Airtable-style
--                     board the user edits before final render)
--
-- Auth model matches the rest of the app: RLS via has_profile_access(),
-- so users only see/touch videos under their own brand profile, and
-- agency-of-one users with multiple profiles see them all.
--
-- Status enums kept as text (with CHECK constraints) instead of true
-- pg enums because future flow tweaks happen often and adding an enum
-- value requires a migration; CHECK constraints can be amended in
-- place without locking the table.

-- ── studio_videos ───────────────────────────────────────────────────────────
create table if not exists public.studio_videos (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,

  -- User inputs from the "new video" form
  title text,
  topic_prompt text not null,
  reference_url text,        -- optional YouTube / source URL
  reference_text text,       -- optional pasted data / outline
  avatar_id text,            -- HeyGen avatar id (or null for VO-only)
  voice_id text,             -- ElevenLabs voice id (defaults to brand voice clone)
  target_duration_secs integer not null default 120
    check (target_duration_secs between 30 and 300),  -- v1 cap = 5min
  aspect_ratio text not null default '16:9'
    check (aspect_ratio in ('16:9','9:16','1:1')),

  -- Project state machine
  status text not null default 'draft'
    check (status in (
      'draft',       -- form filled, not yet mapped
      'mapping',     -- Claude segmentation in progress
      'mapped',      -- video map ready for user review
      'editing',     -- user is iterating on segments
      'rendering',   -- final bake in progress
      'rendered',    -- final_video_url is live
      'failed'
    )),

  -- Outputs
  script_full_text text,     -- full script Claude generated (pre-segmentation)
  final_video_url text,      -- Supabase storage URL post-render
  credits_used numeric(10,2) not null default 0,
  error text,                -- last failure reason if status='failed'

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists studio_videos_profile_idx
  on public.studio_videos (profile_id, created_at desc);
create index if not exists studio_videos_user_idx
  on public.studio_videos (user_id, created_at desc);
create index if not exists studio_videos_status_idx
  on public.studio_videos (status) where status in ('mapping','rendering');

alter table public.studio_videos enable row level security;

drop policy if exists studio_videos_select on public.studio_videos;
create policy studio_videos_select on public.studio_videos
  for select using (public.has_profile_access(profile_id));

drop policy if exists studio_videos_insert on public.studio_videos;
create policy studio_videos_insert on public.studio_videos
  for insert with check (public.has_profile_access(profile_id));

drop policy if exists studio_videos_update on public.studio_videos;
create policy studio_videos_update on public.studio_videos
  for update using (public.has_profile_access(profile_id));

drop policy if exists studio_videos_delete on public.studio_videos;
create policy studio_videos_delete on public.studio_videos
  for delete using (public.has_profile_access(profile_id));

-- ── studio_segments ─────────────────────────────────────────────────────────
create table if not exists public.studio_segments (
  id uuid primary key default gen_random_uuid(),
  studio_video_id uuid not null references public.studio_videos(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  -- profile_id is denormalized from the parent so RLS policies can use
  -- has_profile_access() without joining studio_videos on every check.

  -- Ordering (0-based). Gaps are fine; we order by this column.
  segment_index integer not null,

  -- What this segment IS
  segment_type text not null
    check (segment_type in (
      'avatar',                    -- avatar lip-syncs the script_text
      'voiceover_broll',           -- VO + still image with Ken Burns motion
      'voiceover_motion_graphics', -- VO + HyperFrames composition
      'pure_motion_graphics'       -- no VO, just motion graphics + SFX/music
    )),
  script_text text,            -- what the avatar/VO says (null for pure motion gfx)
  approved boolean not null default false,

  -- Generated assets
  voice_url text,              -- ElevenLabs output (Supabase storage)
  voice_duration_secs numeric(7,3),
  avatar_video_url text,       -- HeyGen output, only on segment_type='avatar'
  image_prompt text,           -- Nano Banana prompt for B-roll rows
  image_url text,              -- Nano Banana output (Supabase storage)

  -- Direction the LLM wrote into the row, user-editable
  motion_gesture_prompt text,  -- avatar gesture/expression direction for HeyGen
  broll_video_prompt text,     -- reserved for future Seedance/Kling B-roll video

  -- HyperFrames overlay config (the "see it in HTML before render" layer)
  hyperframes_composition_id text,
  hyperframes_variables jsonb default '{}'::jsonb,

  -- Cut + scene polish
  transition_in text not null default 'cut'
    check (transition_in in ('cut','fade','crossfade','whip','zoom','wipe','dip_to_black')),
  sound_effect text,           -- SFX library key (null = none)

  -- Per-segment lifecycle
  status text not null default 'pending'
    check (status in (
      'pending',
      'generating_image',
      'generating_audio',
      'generating_avatar',
      'rendering_chunk',
      'ready',
      'error'
    )),
  error text,
  rendered_chunk_url text,     -- partial re-render artifact (Supabase storage)

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Same (video, index) combo should be unique so reorder ops can swap
  -- indexes safely via a transaction. Drop + add inside a tx to enforce.
  constraint studio_segments_video_index_unique
    unique (studio_video_id, segment_index) deferrable initially deferred
);

create index if not exists studio_segments_video_idx
  on public.studio_segments (studio_video_id, segment_index);
create index if not exists studio_segments_profile_idx
  on public.studio_segments (profile_id, created_at desc);
create index if not exists studio_segments_status_idx
  on public.studio_segments (status)
  where status in ('generating_image','generating_audio','generating_avatar','rendering_chunk');

alter table public.studio_segments enable row level security;

drop policy if exists studio_segments_select on public.studio_segments;
create policy studio_segments_select on public.studio_segments
  for select using (public.has_profile_access(profile_id));

drop policy if exists studio_segments_insert on public.studio_segments;
create policy studio_segments_insert on public.studio_segments
  for insert with check (public.has_profile_access(profile_id));

drop policy if exists studio_segments_update on public.studio_segments;
create policy studio_segments_update on public.studio_segments
  for update using (public.has_profile_access(profile_id));

drop policy if exists studio_segments_delete on public.studio_segments;
create policy studio_segments_delete on public.studio_segments
  for delete using (public.has_profile_access(profile_id));

-- ── updated_at triggers ─────────────────────────────────────────────────────
-- Mirror the pattern other tables use (e.g. content_scripts) so the
-- updated_at column always reflects the latest write without the API
-- having to remember to set it.
create or replace function public.studio_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists studio_videos_touch on public.studio_videos;
create trigger studio_videos_touch
  before update on public.studio_videos
  for each row execute function public.studio_touch_updated_at();

drop trigger if exists studio_segments_touch on public.studio_segments;
create trigger studio_segments_touch
  before update on public.studio_segments
  for each row execute function public.studio_touch_updated_at();

comment on table public.studio_videos is
  'Studio long-form video projects. One row per video the user is building.';
comment on table public.studio_segments is
  'Studio video map rows. One per segment of a studio_video. Order by segment_index.';
