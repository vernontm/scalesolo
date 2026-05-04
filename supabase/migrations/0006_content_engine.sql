-- ============================================================================
-- M6: Content engine — approval queue, recycling, hashtag library.
-- Extends the existing content_scripts table from baseline.
-- ============================================================================

alter table public.content_scripts
  add column if not exists needs_approval     boolean default false,
  add column if not exists approval_status    text check (approval_status in ('pending','approved','rejected')),
  add column if not exists approved_by        uuid,
  add column if not exists approved_at        timestamptz,
  add column if not exists rejected_reason    text,
  add column if not exists recycle_period_days int,
  add column if not exists last_recycled_at   timestamptz,
  add column if not exists generated_by       text,                  -- 'human' / 'agent' / 'bulk'
  add column if not exists generation_prompt  text,
  add column if not exists performance        jsonb default '{}'::jsonb;

-- Index for the approvals queue (filter by profile + pending status)
create index if not exists content_scripts_pending_approval
  on public.content_scripts(profile_id, updated_at desc)
  where approval_status = 'pending';

-- Hashtag library on the profile (per-platform sets)
alter table public.profiles
  add column if not exists hashtag_sets jsonb default '{}'::jsonb;
