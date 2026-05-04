-- ============================================================================
-- M5: CRM expansion
-- Sales pipeline (kanban), forms builder, CSV import jobs, contact activity
-- timeline. All profile-scoped with strict RLS via has_profile_access.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Sales pipeline
-- ──────────────────────────────────────────────────────────────────────────
create table public.pipelines (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  name        text not null,
  stages      jsonb not null default '["Lead","Qualified","Proposal","Negotiation","Won","Lost"]'::jsonb,
  is_default  boolean default false,
  sort_order  int default 0,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index pipelines_profile on public.pipelines(profile_id);

create table public.deals (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  pipeline_id     uuid not null references public.pipelines(id) on delete cascade,
  contact_id      uuid references public.email_contacts(id) on delete set null,
  title           text not null,
  stage           text not null,
  value           numeric default 0,
  expected_close_at date,
  age_started_at  timestamptz default now(),
  closed_at       timestamptz,
  win_loss_reason text,
  notes           text,
  custom_fields   jsonb default '{}'::jsonb,
  position        int default 0,                  -- per-stage ordering for kanban
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create index deals_pipeline_stage on public.deals(pipeline_id, stage, position);
create index deals_profile_idx    on public.deals(profile_id);
create index deals_contact_idx    on public.deals(contact_id) where contact_id is not null;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Forms + submissions
-- ──────────────────────────────────────────────────────────────────────────
create table public.forms (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  name          text not null,
  slug          text not null,                    -- public URL: /f/<slug>
  layout        text not null default 'standard'
    check (layout in ('standard','conversational')),
  -- Each section: { id, type, label, fields: [...], conditions: {...} }
  sections      jsonb not null default '[]'::jsonb,
  -- Confirmation: { kind: 'message'|'redirect'|'sequence', message?, url?, sequence_id? }
  confirmation  jsonb not null default '{"kind":"message","message":"Thanks — we got it."}'::jsonb,
  spam          jsonb not null default '{"honeypot":true,"recaptcha":false,"rate_limit":10}'::jsonb,
  is_published  boolean default false,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (profile_id, slug)
);
create index forms_profile on public.forms(profile_id);

create table public.form_submissions (
  id           uuid primary key default gen_random_uuid(),
  form_id      uuid not null references public.forms(id) on delete cascade,
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  contact_id   uuid references public.email_contacts(id) on delete set null,
  payload      jsonb not null,                    -- raw answers
  source_url   text,
  ip_address   inet,
  user_agent   text,
  created_at   timestamptz default now()
);
create index form_subs_form on public.form_submissions(form_id, created_at desc);
create index form_subs_profile on public.form_submissions(profile_id, created_at desc);

-- ──────────────────────────────────────────────────────────────────────────
-- 3. CSV import jobs
-- ──────────────────────────────────────────────────────────────────────────
create table public.import_jobs (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  user_id         uuid not null,                  -- who started the import
  source_filename text not null,
  total_rows      int not null,
  imported_count  int default 0,
  skipped_count   int default 0,
  failed_count    int default 0,
  status          text default 'pending'
    check (status in ('pending','running','complete','failed')),
  field_mapping   jsonb not null,                 -- { csv_col: 'email' }
  error_log       jsonb default '[]'::jsonb,
  created_at      timestamptz default now(),
  completed_at    timestamptz
);
create index import_jobs_profile on public.import_jobs(profile_id, created_at desc);

-- ──────────────────────────────────────────────────────────────────────────
-- 4. Contact activity timeline
-- ──────────────────────────────────────────────────────────────────────────
create table public.contact_activity (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  contact_id   uuid not null references public.email_contacts(id) on delete cascade,
  event_type   text not null,                     -- 'email_sent','email_opened','form_submitted','deal_moved','tag_added','note_added','imported','call_logged'
  payload      jsonb not null default '{}'::jsonb,
  source       text default 'system'
    check (source in ('system','user','webhook')),
  occurred_at  timestamptz not null default now()
);
create index contact_activity_contact on public.contact_activity(contact_id, occurred_at desc);
create index contact_activity_profile on public.contact_activity(profile_id, occurred_at desc);
create index contact_activity_event   on public.contact_activity(profile_id, event_type, occurred_at desc);

-- ──────────────────────────────────────────────────────────────────────────
-- updated_at triggers
-- ──────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  for t in select unnest(array['pipelines','deals','forms','import_jobs']) loop
    execute format(
      'drop trigger if exists trg_touch_%1$s on public.%1$I; create trigger trg_touch_%1$s before update on public.%1$I for each row execute function public.touch_updated_at();',
      t
    );
  end loop;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- Helper: append an activity event. Service-role only.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.log_activity(
  p_profile_id uuid, p_contact_id uuid, p_event_type text,
  p_payload jsonb default '{}'::jsonb, p_source text default 'system'
) returns uuid
language plpgsql security definer as $$
declare v_id uuid;
begin
  insert into public.contact_activity (profile_id, contact_id, event_type, payload, source)
    values (p_profile_id, p_contact_id, p_event_type, p_payload, p_source)
    returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.log_activity(uuid, uuid, text, jsonb, text) to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- RLS — strict per profile, except form_submissions which can be inserted
-- by anyone (anonymous public form submission). Reads still scoped.
-- ──────────────────────────────────────────────────────────────────────────
alter table public.pipelines        enable row level security;
alter table public.deals            enable row level security;
alter table public.forms            enable row level security;
alter table public.form_submissions enable row level security;
alter table public.import_jobs      enable row level security;
alter table public.contact_activity enable row level security;

do $$
declare t text;
begin
  -- standard tenant policies for the editable tables
  for t in select unnest(array['pipelines','deals','forms','import_jobs','contact_activity']) loop
    execute format($f$
      create policy %1$I_select on public.%1$I for select to authenticated using (public.has_profile_access(profile_id, 'viewer'));
      create policy %1$I_insert on public.%1$I for insert to authenticated with check (public.has_profile_access(profile_id, 'editor'));
      create policy %1$I_update on public.%1$I for update to authenticated using (public.has_profile_access(profile_id, 'editor')) with check (public.has_profile_access(profile_id, 'editor'));
      create policy %1$I_delete on public.%1$I for delete to authenticated using (public.has_profile_access(profile_id, 'admin'));
    $f$, t);
  end loop;
end $$;

-- form_submissions: tenants read; anon/authenticated cannot insert directly
-- (form submissions go through our /api/forms/submit endpoint with service role).
create policy form_subs_select on public.form_submissions
  for select to authenticated
  using (public.has_profile_access(profile_id, 'viewer'));
