-- 0083 - row level security for the automation tables
--
-- 0082 created the three automation tables and forgot this, which every other
-- email table already has. The anon key ships inside the SPA bundle, so a
-- table with RLS switched off is readable and writable by anyone who opens
-- the site: every brand's sequences, trigger tags and enrollment rows (which
-- carry contact ids) would have been public. Enabling RLS with no policy
-- denies anon and authenticated outright; the policies then hand access back
-- to the people who already have it on the rest of the email tables.
--
-- The API is unaffected either way, because it talks to Postgres with the
-- service role key, which bypasses RLS. This is the second line of defence,
-- and it matches email_contacts and email_campaigns exactly: viewer to read,
-- editor to write, admin to delete.

alter table public.email_automations            enable row level security;
alter table public.email_automation_steps       enable row level security;
alter table public.email_automation_enrollments enable row level security;

-- Dropped first so this migration is safe to run twice, and so a database
-- that already picked up an earlier copy of these policies converges.
drop policy if exists email_automations_select on public.email_automations;
drop policy if exists email_automations_insert on public.email_automations;
drop policy if exists email_automations_update on public.email_automations;
drop policy if exists email_automations_delete on public.email_automations;

create policy email_automations_select on public.email_automations
  for select to authenticated using (has_profile_access(profile_id, 'viewer'));
create policy email_automations_insert on public.email_automations
  for insert to authenticated with check (has_profile_access(profile_id, 'editor'));
create policy email_automations_update on public.email_automations
  for update to authenticated using (has_profile_access(profile_id, 'editor'))
  with check (has_profile_access(profile_id, 'editor'));
create policy email_automations_delete on public.email_automations
  for delete to authenticated using (has_profile_access(profile_id, 'admin'));

-- A step has no profile_id of its own, so it inherits access from its parent
-- automation. The subquery is itself filtered by the policies above, which
-- say the same thing, so the two cannot disagree.
drop policy if exists email_automation_steps_select on public.email_automation_steps;
drop policy if exists email_automation_steps_insert on public.email_automation_steps;
drop policy if exists email_automation_steps_update on public.email_automation_steps;
drop policy if exists email_automation_steps_delete on public.email_automation_steps;

create policy email_automation_steps_select on public.email_automation_steps
  for select to authenticated using (
    exists (
      select 1 from public.email_automations a
      where a.id = email_automation_steps.automation_id
        and has_profile_access(a.profile_id, 'viewer')
    )
  );
create policy email_automation_steps_insert on public.email_automation_steps
  for insert to authenticated with check (
    exists (
      select 1 from public.email_automations a
      where a.id = email_automation_steps.automation_id
        and has_profile_access(a.profile_id, 'editor')
    )
  );
create policy email_automation_steps_update on public.email_automation_steps
  for update to authenticated using (
    exists (
      select 1 from public.email_automations a
      where a.id = email_automation_steps.automation_id
        and has_profile_access(a.profile_id, 'editor')
    )
  ) with check (
    exists (
      select 1 from public.email_automations a
      where a.id = email_automation_steps.automation_id
        and has_profile_access(a.profile_id, 'editor')
    )
  );
create policy email_automation_steps_delete on public.email_automation_steps
  for delete to authenticated using (
    exists (
      select 1 from public.email_automations a
      where a.id = email_automation_steps.automation_id
        and has_profile_access(a.profile_id, 'admin')
    )
  );

drop policy if exists email_automation_enrollments_select on public.email_automation_enrollments;
drop policy if exists email_automation_enrollments_insert on public.email_automation_enrollments;
drop policy if exists email_automation_enrollments_update on public.email_automation_enrollments;
drop policy if exists email_automation_enrollments_delete on public.email_automation_enrollments;

create policy email_automation_enrollments_select on public.email_automation_enrollments
  for select to authenticated using (has_profile_access(profile_id, 'viewer'));
create policy email_automation_enrollments_insert on public.email_automation_enrollments
  for insert to authenticated with check (has_profile_access(profile_id, 'editor'));
create policy email_automation_enrollments_update on public.email_automation_enrollments
  for update to authenticated using (has_profile_access(profile_id, 'editor'))
  with check (has_profile_access(profile_id, 'editor'));
create policy email_automation_enrollments_delete on public.email_automation_enrollments
  for delete to authenticated using (has_profile_access(profile_id, 'admin'));
