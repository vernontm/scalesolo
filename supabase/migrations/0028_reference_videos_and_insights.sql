-- Reference videos + brand_bible_insights + transcription_usage. See
-- the production-applied migration for full body — this file mirrors
-- it for the migration history. Tables back the URL Reference + Bible
-- Builder + Content Remix flows.
create table if not exists public.reference_videos (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  source_url text not null,
  resolved_media_url text,
  creator_handle text,
  thumbnail_url text,
  duration_secs integer,
  transcript text,
  transcript_lang text,
  mode text not null default 'competitor' check (mode in ('competitor','remix_source','reference')),
  status text not null default 'pending' check (status in ('pending','transcribing','ready','failed')),
  error text,
  meta jsonb,
  tags text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reference_videos_profile_idx
  on public.reference_videos (profile_id, status, created_at desc);
create index if not exists reference_videos_url_idx
  on public.reference_videos (profile_id, source_url);

create table if not exists public.brand_bible_insights (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  source_video_id uuid references public.reference_videos(id) on delete cascade,
  insight_type text not null,
  title text,
  payload jsonb,
  status text not null default 'pending' check (status in ('pending','approved','rejected','applied')),
  reviewed_at timestamptz,
  applied_to jsonb,
  created_at timestamptz not null default now()
);
create index if not exists brand_bible_insights_profile_idx
  on public.brand_bible_insights (profile_id, status, created_at desc);
create index if not exists brand_bible_insights_source_idx
  on public.brand_bible_insights (source_video_id);

create table if not exists public.transcription_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  period text not null,
  count integer not null default 0,
  duration_secs integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, period)
);

alter table public.reference_videos enable row level security;
drop policy if exists rv_select on public.reference_videos;
create policy rv_select on public.reference_videos for select using (public.has_profile_access(profile_id));
drop policy if exists rv_insert on public.reference_videos;
create policy rv_insert on public.reference_videos for insert with check (public.has_profile_access(profile_id));
drop policy if exists rv_update on public.reference_videos;
create policy rv_update on public.reference_videos for update using (public.has_profile_access(profile_id));
drop policy if exists rv_delete on public.reference_videos;
create policy rv_delete on public.reference_videos for delete using (public.has_profile_access(profile_id));

alter table public.brand_bible_insights enable row level security;
drop policy if exists bbi_select on public.brand_bible_insights;
create policy bbi_select on public.brand_bible_insights for select using (public.has_profile_access(profile_id));
drop policy if exists bbi_update on public.brand_bible_insights;
create policy bbi_update on public.brand_bible_insights for update using (public.has_profile_access(profile_id));
drop policy if exists bbi_delete on public.brand_bible_insights;
create policy bbi_delete on public.brand_bible_insights for delete using (public.has_profile_access(profile_id));

alter table public.transcription_usage enable row level security;
drop policy if exists tu_select on public.transcription_usage;
create policy tu_select on public.transcription_usage for select using (auth.uid() = user_id);
