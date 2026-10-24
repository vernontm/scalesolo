-- Allow 'mailgun' as an email provider.
--
-- email_config.email_provider was constrained to ses / postmark / mailerlite
-- when SES was the only one wired up. Mailgun was added on 2026-10-24 after
-- SES production access was denied, and without this the Sender tab fails to
-- save for any Mailgun brand with a raw check-constraint violation.
--
-- Widening an allowed set, so it cannot invalidate an existing row.

alter table public.email_config
  drop constraint if exists email_config_email_provider_check;

alter table public.email_config
  add constraint email_config_email_provider_check
  check (email_provider = any (array['ses'::text, 'mailgun'::text, 'postmark'::text, 'mailerlite'::text]));
