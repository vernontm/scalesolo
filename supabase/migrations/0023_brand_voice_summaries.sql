-- Brand voice summaries — Phase 2 of brand voice training.
-- A daily cron (api/cron/distill-brand-voice.js) walks the prior 24h of
-- rated brand_scripts/brand_hooks per profile and asks Claude to distill
-- the patterns the user is approving vs rejecting into a compact summary.
-- That summary is then injected into the script_gen system prompt so the
-- voice gets sharper over time without anyone editing the brand bible by
-- hand. Old summaries are kept (history) but only the latest is_active=true
-- row is read at generation time.

create table if not exists public.brand_voice_summaries (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  summary text not null,
  liked_patterns text,
  disliked_patterns text,
  sample_size int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists brand_voice_summaries_active_idx
  on public.brand_voice_summaries(profile_id, is_active, created_at desc);

alter table public.brand_voice_summaries enable row level security;

drop policy if exists brand_voice_summaries_select on public.brand_voice_summaries;
create policy brand_voice_summaries_select on public.brand_voice_summaries
  for select using (public.has_profile_access(profile_id));

-- Writes are server-only (cron uses service role), so no insert/update
-- policy for clients. Keeping RLS on means anon/authed reads are gated
-- through has_profile_access just like the rest of the brand voice tables.
