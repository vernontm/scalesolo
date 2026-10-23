-- Audit log for the VTM CRM integration.
-- Every write performed through /api/integrations is recorded here with the
-- acting VTM user and role, so changes to a brand's live schedule are
-- attributable. Reads are not logged. Append-only; service-role writes only.
--
-- PROPOSE-ONLY: apply this in the ScaleSolo Supabase project before enabling
-- the integration. The audit() helper fails soft, so the endpoints work before
-- this is applied, they just do not record until the table exists.

create table if not exists public.integration_audit (
  id          uuid primary key default gen_random_uuid(),
  source      text not null default 'vtm_crm',
  actor_id    text,                 -- the VTM user id (opaque to ScaleSolo)
  actor_role  text,                 -- viewer | manager | admin
  action      text not null,        -- edit-caption | approve-card | move-card | set-defaults | ...
  profile_id  uuid references public.profiles(id) on delete set null,
  target_id   text,                 -- content_scripts.id / board_cards.id acted on
  result      text not null default 'ok',   -- ok | denied | error
  meta        jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists integration_audit_profile_idx on public.integration_audit (profile_id, created_at desc);
create index if not exists integration_audit_created_idx on public.integration_audit (created_at desc);

alter table public.integration_audit enable row level security;
-- No permissive policies: only the service role (used by the API) can read or
-- write this table. Add an admin-read policy later if an in-app audit view is
-- wanted.
