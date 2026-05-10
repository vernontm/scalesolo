-- Unified feedback signal across every Claude-driven output. Each
-- thumbs-up / thumbs-down / star / comment goes here, regardless of
-- whether the source was a script, caption, image, avatar render, or
-- agent reply. The daily distill-brand-voice cron reads from here so
-- the brand voice summary keeps tightening from real signal across
-- the whole product, not just the script library.
create table if not exists public.brand_feedback (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  source text not null check (source in (
    'script','caption','first_comment','hook','title','image','avatar_render','agent_reply','landing_page','remix','other'
  )),
  ref_id text,
  rating smallint not null check (rating in (-1, 0, 1)),
  notes text,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists brand_feedback_profile_idx
  on public.brand_feedback (profile_id, source, created_at desc);
create index if not exists brand_feedback_recent_idx
  on public.brand_feedback (created_at desc) where rating <> 0;

alter table public.brand_feedback enable row level security;

drop policy if exists brand_feedback_select on public.brand_feedback;
create policy brand_feedback_select on public.brand_feedback
  for select using (public.has_profile_access(profile_id));

drop policy if exists brand_feedback_insert on public.brand_feedback;
create policy brand_feedback_insert on public.brand_feedback
  for insert with check (public.has_profile_access(profile_id));

drop policy if exists brand_feedback_update on public.brand_feedback;
create policy brand_feedback_update on public.brand_feedback
  for update using (public.has_profile_access(profile_id));
