-- 0055 — email_contacts.last_drip_at
--
-- Tracks the timestamp of the most recent drip email sent to a contact.
-- The funnel-drip cron uses this to space out welcome / nurture / win-back
-- emails (e.g. "send next email only if >=2 days since last_drip_at").
-- Nullable so existing rows survive without backfill.

alter table public.email_contacts
  add column if not exists last_drip_at timestamptz;

create index if not exists email_contacts_last_drip_at_idx
  on public.email_contacts (last_drip_at)
  where last_drip_at is not null;
