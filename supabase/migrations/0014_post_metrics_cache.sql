-- Cache for per-post Upload-Post engagement metrics. The dashboard
-- otherwise fans out one HTTP call per recent post on every cache
-- miss; this table lets us skip that work for posts whose metrics
-- haven't moved since the last fetch.

create table if not exists public.post_metrics_cache (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  uploadpost_request_id text not null,
  content_script_id uuid,
  views integer not null default 0,
  likes integer not null default 0,
  comments integer not null default 0,
  shares integer not null default 0,
  saves integer not null default 0,
  raw jsonb,
  fetched_at timestamptz not null default now(),
  constraint post_metrics_cache_request_unique unique (uploadpost_request_id)
);
create index if not exists post_metrics_cache_profile_idx on public.post_metrics_cache (profile_id);
create index if not exists post_metrics_cache_fetched_idx on public.post_metrics_cache (fetched_at);
create index if not exists post_metrics_cache_script_idx  on public.post_metrics_cache (content_script_id);

alter table public.post_metrics_cache enable row level security;

drop policy if exists post_metrics_cache_self_read on public.post_metrics_cache;
create policy post_metrics_cache_self_read on public.post_metrics_cache
  for select using (
    exists (
      select 1 from public.profile_access pa
      where pa.profile_id = post_metrics_cache.profile_id
        and pa.user_id = auth.uid()
    )
  );
