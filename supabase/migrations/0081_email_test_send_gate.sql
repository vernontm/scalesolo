-- 0081: a campaign cannot reach a real list until someone has read it in an
-- inbox.
--
-- Why two columns instead of one boolean:
--
--   last_test_sent_at    set by POST /api/email/campaigns?action=test
--   content_changed_at   set by the PATCH handler ONLY when subject,
--                        html_body or preview_text actually change
--
-- The gate on ?action=send and ?action=schedule is
--   last_test_sent_at is not null and last_test_sent_at >= content_changed_at
-- so a test proves the copy that is about to go out, not some earlier draft.
-- Editing the audience, the from name or the reply-to does NOT invalidate the
-- test: none of those change what the subscriber reads, and forcing a re-test
-- for them would just train people to click through the gate.
--
-- Timestamps rather than a hash of the body so the UI can say "tested 10
-- minutes ago, edited since" and a human can audit it in the table.
--
-- Campaigns that are already scheduled when this ships are unaffected: the
-- gate runs at send/schedule time, not in the cron worker, so nothing in
-- flight gets stranded.
--
-- The cron worker deliberately does NOT re-check the gate, or a campaign in
-- flight could silently fail to send. So that editing a scheduled campaign
-- cannot smuggle untested copy past it, the PATCH handler pulls such a
-- campaign back to draft (status 'draft', scheduled_at null) when the copy
-- changes, and says so. Visible beats both silently sending untested copy and
-- silently sending nothing.

alter table public.email_campaigns
  add column if not exists last_test_sent_at  timestamptz,
  add column if not exists content_changed_at timestamptz;

comment on column public.email_campaigns.last_test_sent_at is
  'When a test message was last sent for this campaign. Required before send/schedule.';
comment on column public.email_campaigns.content_changed_at is
  'When subject / html_body / preview_text last changed. A test older than this does not count.';
