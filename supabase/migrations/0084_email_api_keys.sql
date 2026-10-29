-- 0084 - per-brand ingest keys for POST /api/email/subscribe.
--
-- An outside system (a client's website, a Zapier zap, a Shopify or Calendly
-- webhook) needs to add a tagged contact to ONE brand's list. Until now the
-- only credential that could do that was WORKFLOW_INTERNAL_SECRET, which
-- impersonates a user across every brand on the account, so it could never be
-- handed out. A key here is scoped to a single profile_id and can do exactly
-- one thing: upsert a contact on that brand's list.
--
-- Only the SHA-256 of the key is stored. A database leak therefore hands over
-- nothing usable, and a key cannot be read back after it is issued, which is
-- why the UI shows it once. key_prefix exists purely so a human can tell two
-- keys apart in the list.
--
-- RLS is on with the same four policies as every other email table, and the
-- lesson from 0082 is the reason it is in this file rather than a follow-up:
-- the anon key ships inside the SPA bundle, so a table left without RLS is
-- readable and writable by anyone who opens the site. These rows are
-- admin-only rather than viewer-readable, because knowing a brand has a live
-- ingest key, and its name, is not something a viewer needs.

create table if not exists public.email_api_keys (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  name         text not null,
  -- SHA-256 hex of the key. Unique so the same key cannot be registered twice.
  key_hash     text not null unique,
  -- First few characters, for display only ("ssk_live_a1b2c3").
  key_prefix   text not null,
  active       boolean not null default true,
  last_used_at timestamptz,
  created_by   uuid,
  created_at   timestamptz not null default now()
);

-- The hot path: one lookup per incoming lead, by hash, live keys only.
create index if not exists email_api_keys_hash_idx
  on public.email_api_keys (key_hash) where active;
create index if not exists email_api_keys_profile_idx
  on public.email_api_keys (profile_id);

comment on table public.email_api_keys is
  'Per-brand ingest keys for POST /api/email/subscribe. SHA-256 only, never the key itself. Scoped to one profile_id so a key can only write to its own brand list.';

alter table public.email_api_keys enable row level security;

drop policy if exists email_api_keys_select on public.email_api_keys;
drop policy if exists email_api_keys_insert on public.email_api_keys;
drop policy if exists email_api_keys_update on public.email_api_keys;
drop policy if exists email_api_keys_delete on public.email_api_keys;

create policy email_api_keys_select on public.email_api_keys
  for select to authenticated using (has_profile_access(profile_id, 'admin'));
create policy email_api_keys_insert on public.email_api_keys
  for insert to authenticated with check (has_profile_access(profile_id, 'admin'));
create policy email_api_keys_update on public.email_api_keys
  for update to authenticated using (has_profile_access(profile_id, 'admin'))
  with check (has_profile_access(profile_id, 'admin'));
create policy email_api_keys_delete on public.email_api_keys
  for delete to authenticated using (has_profile_access(profile_id, 'admin'));
