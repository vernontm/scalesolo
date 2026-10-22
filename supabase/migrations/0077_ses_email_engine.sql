-- Native email sending through Amazon SES (the "Milestone 4" email engine).
--
-- Until now email_config / email_campaigns existed from the baseline but
-- nothing in api/ sent anything: campaigns were a MailerLite relay in the
-- old VTM CRM. This migration makes ScaleSolo its own sender:
--
--   email_domains       a brand's own sending domain, verified in SES with
--                       Easy DKIM + a custom MAIL FROM. Brands that do not
--                       verify a domain send from the shared
--                       mail.scalesolo.ai identity instead.
--   email_sends         one row per (campaign, contact). Written BEFORE the
--                       SES call so two workers can never double-send:
--                       the unique index makes the second insert fail.
--   email_suppressions  addresses we must never send to again. Hard bounces
--                       and complaints are global (profile_id null) because
--                       a dead mailbox is dead for every brand. Unsubscribes
--                       are per brand.
--
-- Counters on email_campaigns are bumped by the SES event webhook through
-- bump_email_campaign_counter so concurrent events do not lose updates.

-- 1. email_config: SES becomes the default provider, plus the CAN-SPAM
--    postal address that goes in every footer.
alter table public.email_config
  drop constraint if exists email_config_email_provider_check;
alter table public.email_config
  alter column email_provider set default 'ses';
alter table public.email_config
  add constraint email_config_email_provider_check
  check (email_provider in ('ses', 'postmark', 'mailerlite'));
alter table public.email_config
  add column if not exists postal_address text,
  add column if not exists updated_by uuid;

-- 2. email_campaigns: delivery counters, sender snapshot, worker bookkeeping.
alter table public.email_campaigns
  add column if not exists delivered_count    int default 0,
  add column if not exists bounced_count      int default 0,
  add column if not exists complained_count   int default 0,
  add column if not exists unsubscribed_count int default 0,
  add column if not exists from_name          text,
  add column if not exists from_email         text,
  add column if not exists reply_to           text,
  add column if not exists started_at         timestamptz,
  add column if not exists last_error         text;

-- 3. Brand sending domains.
create table if not exists public.email_domains (
  id               uuid primary key default gen_random_uuid(),
  profile_id       uuid not null references public.profiles(id) on delete cascade,
  domain           text not null,
  status           text not null default 'pending' check (status in ('pending', 'verified', 'failed')),
  dkim_tokens      jsonb default '[]'::jsonb,
  mail_from_domain text,
  dkim_status      text,
  mail_from_status text,
  verified_at      timestamptz,
  last_checked_at  timestamptz,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  unique (domain)
);
create index if not exists email_domains_profile_idx on public.email_domains(profile_id);

-- 4. Per-recipient send log.
create table if not exists public.email_sends (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid not null references public.email_campaigns(id) on delete cascade,
  profile_id     uuid not null references public.profiles(id) on delete cascade,
  contact_id     uuid references public.email_contacts(id) on delete set null,
  email          text not null,
  status         text not null default 'queued'
                 check (status in ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed')),
  ses_message_id text,
  error          text,
  opened_at      timestamptz,
  clicked_at     timestamptz,
  sent_at        timestamptz,
  delivered_at   timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
create unique index if not exists email_sends_campaign_contact_uidx
  on public.email_sends (campaign_id, contact_id);
create index if not exists email_sends_message_idx on public.email_sends (ses_message_id);
create index if not exists email_sends_campaign_status_idx on public.email_sends (campaign_id, status);

-- 5. Suppression list.
create table if not exists public.email_suppressions (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid references public.profiles(id) on delete cascade,   -- null = global
  email       text not null,
  reason      text not null check (reason in ('bounce', 'complaint', 'unsubscribe', 'manual')),
  source      text,
  created_at  timestamptz default now()
);
create unique index if not exists email_suppressions_scope_uidx
  on public.email_suppressions (coalesce(profile_id, '00000000-0000-0000-0000-000000000000'::uuid), email);
create index if not exists email_suppressions_email_idx on public.email_suppressions (email);

-- 6. RLS, same shape as the baseline generator.
alter table public.email_domains      enable row level security;
alter table public.email_sends        enable row level security;
alter table public.email_suppressions enable row level security;

do $$
declare
  t text;
begin
  for t in select unnest(array['email_domains', 'email_sends', 'email_suppressions'])
  loop
    execute format($f$
      drop policy if exists %1$I_select on public.%1$I;
      create policy %1$I_select on public.%1$I
        for select to authenticated
        using (profile_id is not null and public.has_profile_access(profile_id, 'viewer'));

      drop policy if exists %1$I_insert on public.%1$I;
      create policy %1$I_insert on public.%1$I
        for insert to authenticated
        with check (profile_id is not null and public.has_profile_access(profile_id, 'editor'));

      drop policy if exists %1$I_update on public.%1$I;
      create policy %1$I_update on public.%1$I
        for update to authenticated
        using (profile_id is not null and public.has_profile_access(profile_id, 'editor'))
        with check (profile_id is not null and public.has_profile_access(profile_id, 'editor'));

      drop policy if exists %1$I_delete on public.%1$I;
      create policy %1$I_delete on public.%1$I
        for delete to authenticated
        using (profile_id is not null and public.has_profile_access(profile_id, 'admin'));
    $f$, t);
  end loop;
end $$;

-- 7. Atomic counter bump for the webhook. Column name is whitelisted so the
--    dynamic SQL can never be pointed at anything else.
create or replace function public.bump_email_campaign_counter(p_campaign uuid, p_col text, p_n int default 1)
returns void
language plpgsql
security definer
as $$
begin
  if p_col not in ('sent_count', 'failed_count', 'opened_count', 'clicked_count',
                   'delivered_count', 'bounced_count', 'complained_count', 'unsubscribed_count') then
    raise exception 'bump_email_campaign_counter: column % not allowed', p_col;
  end if;
  execute format('update public.email_campaigns set %I = coalesce(%I, 0) + $1, updated_at = now() where id = $2', p_col, p_col)
    using p_n, p_campaign;
end;
$$;

revoke all on function public.bump_email_campaign_counter(uuid, text, int) from public;
grant execute on function public.bump_email_campaign_counter(uuid, text, int) to service_role;
