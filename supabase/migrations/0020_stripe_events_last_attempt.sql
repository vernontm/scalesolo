-- Pre-launch: stripe-webhook handler now writes processed_at only on
-- success and last_attempt_at on every attempt. The two-column split
-- lets the idempotency check distinguish "already finished" (skip) from
-- "previous attempt failed mid-flight" (retry on next webhook delivery).

alter table public.stripe_events
  add column if not exists last_attempt_at timestamptz;
