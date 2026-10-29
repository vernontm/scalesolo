-- 0082 - email automations (linear drip sequences, v1)
--
-- A brand can define a sequence that starts when a contact picks up a tag:
-- "tagged funnel:lead-opt-in" -> wait 0h, send welcome -> wait 48h, send
-- the next one, and so on.
--
-- Three decisions worth writing down, because they are what keeps this safe:
--
-- 1. A step IS a campaign. email_automation_steps.campaign_id points at an
--    email_campaigns row (trigger_type = 'tag', status stays 'draft' forever).
--    That is not a shortcut: email_sends already has a UNIQUE index on
--    (campaign_id, contact_id), which is the post-once guarantee for
--    broadcasts, and reusing a campaign per step means a drip step inherits
--    it exactly. A second runner tick cannot send step 2 twice, because the
--    claim insert fails the same way it does for a broadcast. The step also
--    inherits the composer, the merge-tag validator, the footer address check
--    and the test-send gate with no new code.
--    Those campaigns are hidden from the Campaigns list by trigger_type, and
--    the scheduled-send cron never sees them because it looks for status
--    'scheduled' or 'sending'.
--
-- 2. Enrollment is a row, not a tag. The older funnel drip kept sequence
--    position in email_contacts.tags, but api/email/contacts.js caps a
--    contact at 20 tags, so one brand running three sequences would exhaust
--    the budget and silently stop advancing people.
--
-- 3. "From now on" is the default, and it is expressed as skipped rows.
--    Switching an automation on inserts a 'skipped' enrollment for everyone
--    who already carries the trigger tag, so the runner will not mail a
--    backlog of 800 existing contacts their welcome sequence tonight. Opting
--    in to that backlog inserts them as 'active' instead. This is why the
--    enrollment row doubles as the "already seen" record: a contact with no
--    row has newly arrived, whatever their signup date, which a timestamp
--    comparison against signed_up_at would get wrong for someone who already
--    existed and only now joined this list.
--
-- Positions are for ordering and display only. They are deliberately NOT
-- unique per automation, so reordering is a plain sequence of updates rather
-- than a dance around a constraint; the runner walks steps by id, never by
-- position arithmetic.

create table if not exists public.email_automations (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  name          text not null,
  trigger_tag   text not null,
  status        text not null default 'draft' check (status in ('draft', 'active', 'paused')),
  -- When it was last switched on. Kept for the audit trail: the skipped rows
  -- are what actually enforce "from now on".
  enrolls_from  timestamptz,
  last_error    text,
  created_by    uuid,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists email_automations_profile_idx
  on public.email_automations (profile_id);
create index if not exists email_automations_active_idx
  on public.email_automations (status) where status = 'active';

create table if not exists public.email_automation_steps (
  id            uuid primary key default gen_random_uuid(),
  automation_id uuid not null references public.email_automations(id) on delete cascade,
  campaign_id   uuid not null unique references public.email_campaigns(id) on delete cascade,
  position      int not null default 1,
  -- Wait this long after the previous step (or after enrolling, for step 1).
  -- Capped at a year so a typo cannot park someone forever.
  delay_hours   int not null default 0 check (delay_hours >= 0 and delay_hours <= 8760),
  created_at    timestamptz default now()
);

create index if not exists email_automation_steps_automation_idx
  on public.email_automation_steps (automation_id, position);

create table if not exists public.email_automation_enrollments (
  id            uuid primary key default gen_random_uuid(),
  automation_id uuid not null references public.email_automations(id) on delete cascade,
  contact_id    uuid not null references public.email_contacts(id) on delete cascade,
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  status        text not null default 'active' check (status in ('active', 'done', 'skipped', 'cancelled')),
  -- The step this contact is waiting for, and when it is due. A step deleted
  -- mid-flight sets this to null, and the runner reads that as "nothing left
  -- to send" and finishes the contact rather than guessing a position.
  next_step_id  uuid references public.email_automation_steps(id) on delete set null,
  next_run_at   timestamptz,
  -- Why a contact stopped early: unsubscribed, suppressed, tag removed.
  stopped_reason text,
  enrolled_at   timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (automation_id, contact_id)
);

-- The runner's only hot query: active enrollments that are due.
create index if not exists email_automation_enrollments_due_idx
  on public.email_automation_enrollments (next_run_at)
  where status = 'active';
create index if not exists email_automation_enrollments_automation_idx
  on public.email_automation_enrollments (automation_id, status);
