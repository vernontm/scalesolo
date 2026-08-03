-- Background jobs for the carousel builder. Generation runs as a resumable
-- step machine (plan -> cover -> slide... -> composite -> done) driven by a
-- self-kick plus an every-minute cron, so it never hits the serverless time
-- limit no matter the slide count.

create table if not exists public.carousel_jobs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  profile_id   uuid not null,
  status       text not null default 'queued',   -- queued | working | done | failed
  step         text not null default 'plan',      -- plan | cover | slide | composite | done
  cursor       int  not null default 0,           -- which follower slide is next (step=slide)
  stage        text,                              -- human progress label
  progress     int  not null default 0,           -- 0..100 for the UI
  request      jsonb not null default '{}'::jsonb, -- topic, slide_count, theme, refs, signature...
  state        jsonb not null default '{}'::jsonb, -- plan + locked axes + raw slide urls
  images       text[] not null default '{}',       -- final (composited) slide urls
  content_id   uuid,
  title        text,
  caption      text,
  hashtags     text,
  error        text,
  attempts     int not null default 0,
  claimed_at   timestamptz,                       -- lock so cron + self-kick don't collide
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists carousel_jobs_active_idx
  on public.carousel_jobs (updated_at)
  where status in ('queued', 'working');

create index if not exists carousel_jobs_user_idx
  on public.carousel_jobs (user_id, created_at desc);

alter table public.carousel_jobs enable row level security;
-- Owners can read their own jobs; all writes go through the service role.
drop policy if exists carousel_jobs_owner_select on public.carousel_jobs;
create policy carousel_jobs_owner_select on public.carousel_jobs
  for select using (auth.uid() = user_id);
