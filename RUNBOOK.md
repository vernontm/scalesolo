# ScaleSolo Operations Runbook

The "it's 3am and something's on fire" reference. Each section is one
known failure mode + the exact commands to diagnose + recover.

Update this file every time you respond to a real incident.

---

## Table of contents

1. [Stripe webhook silently failing — paid users with no credits](#stripe-webhook-silently-failing)
2. [User reports "I was charged but didn't get the video"](#unbilled-or-unfulfilled-credit-event)
3. [Avatar render stuck in `generating_clips`](#stuck-avatar-render)
4. [HeyGen 429 / outage cascade](#heygen-down)
5. [Sentry shows `kind:'free_generation_leak'`](#free-generation-leak)
6. [Vercel deploy failure](#vercel-deploy-failure)
7. [Comp credits to a user (support)](#comp-credits)
8. [Rolling back a bad migration](#rolling-back-a-migration)
9. [Daily / weekly health checks](#periodic-health-checks)

---

## Stripe webhook silently failing

**Symptom:** New subscriber paid in Stripe but `tier='trial'` in our DB
and `credit_pools.balance` is zero. They email support saying "I paid
and have no credits."

**Diagnose:**

```sql
-- Did we receive the webhook?
select stripe_event_id, event_type, processed_at, error, last_attempt_at, created_at
from public.stripe_events
where event_type in ('customer.subscription.created', 'invoice.payment_succeeded', 'checkout.session.completed')
order by created_at desc
limit 50;
```

- `processed_at IS NULL` AND `error IS NOT NULL` → handler errored. The
  webhook will keep retrying for ~3 days. Check the `error` column.
- `processed_at IS NULL` AND `error IS NULL` → never even hit the
  handler. Stripe didn't deliver, OR we returned 500 before the row
  insert. Check Stripe Dashboard → Developers → Events.
- `processed_at IS NOT NULL` AND `error IS NULL` → we processed it.
  Bug is downstream — check `billing_subscriptions` and `credit_pools`.

**Recover (manual replay):**
1. Stripe Dashboard → Developers → Events → find the event
2. Click "Resend" — Stripe replays it to our webhook
3. Confirm `stripe_events.processed_at` populates within 30s

If Stripe replay still fails, the bug is in our handler. Pull
`stripe_events.payload` and replay locally:

```bash
curl -X POST https://www.scalesolo.ai/api/stripe-webhook \
  -H "stripe-signature: <copy from Stripe Dashboard>" \
  -H "Content-Type: application/json" \
  -d "$(psql ... -c "select payload::text from stripe_events where stripe_event_id='evt_...';")"
```

**Prevent:** UptimeRobot / BetterStack synthetic check that POSTs a
fake webhook (with a known event_id) every 5 minutes and alerts if
the response isn't 200. Even simpler: check Sentry weekly for
`stripe-webhook routeEvent failed` events.

---

## Unbilled or unfulfilled credit event

**Symptom:** User says "I was charged for a video / image but never
got the result" OR "I generated a video and never got charged."

**Diagnose:**

```sql
-- Recent credits activity for the user.
select id, action, delta, balance_after, ref_id, created_at, metadata
from public.credit_transactions
where customer_id = (select id from billing_customers where user_id='<auth uid>' limit 1)
order by created_at desc
limit 30;
```

Look for:
- A `consume:*` row WITHOUT a matching `refund:*` row → user was
  charged. If they say they got nothing, the upstream task failed and
  the refund didn't fire. Issue a manual refund (see [Comp credits](#comp-credits)).
- A run-completion log line in Vercel logs WITHOUT a matching
  `consume:*` row → free generation leak. Check Sentry for
  `kind:'free_generation_leak'` issues.
- A `refund:*` row → we already refunded; user has the credit back.
  Tell support to refresh the user's view.

For HeyGen renders specifically:

```sql
select id, status, heygen_video_id, video_units_charged, error, created_at
from public.avatar_renders
where profile_id = '<profile uuid>'
order by created_at desc
limit 20;
```

`status='failed'` + recent `created_at` → the cron sweeper or
render-status endpoint should have refunded automatically. Verify
with the credits query above.

---

## Stuck avatar render

**Symptom:** User has an `avatar_renders` row in `generating_clips`
for hours. They closed the tab; client polling stopped.

**Diagnose:**

```sql
select id, profile_id, heygen_video_id, status, created_at, started_at
from public.avatar_renders
where status in ('generating_clips','pending','processing','queued','submitted')
  and created_at < now() - interval '30 minutes'
order by created_at;
```

**Recover:**

The cron at `/api/cron/sweep-stale-renders` runs every 15 min and
should flip these to `failed` + refund. If the cron itself isn't
firing, manually run it:

```bash
curl -X POST https://www.scalesolo.ai/api/cron/sweep-stale-renders \
  -H "Authorization: Bearer $CRON_SECRET"
```

Returns `{ swept, refunded, examined }`. Confirm via Vercel logs.

If the row is stuck because HeyGen's status endpoint is itself broken,
flip manually + refund:

```sql
update avatar_renders set status='failed', error='manual_sweep' where id='<id>';
-- Then refund the consume:photo-avatar-render via grant_credits RPC
-- with action='refund:photo-avatar-render', ref_id = the consume row's ref_id.
```

---

## HeyGen down

**Symptom:** Sentry flooded with `ElevenLabs/HeyGen 429` or `502`.
Users seeing "Render failed."

**Triage:**

1. Check status.heygen.com.
2. If down: post a status notice (Discord / Twitter / banner if you
   have one). Tell users renders are paused.
3. The C5 refund-on-fail wiring + the C11 sweeper handle cleanup
   automatically — no manual intervention needed for stuck rows.
4. New renders during the outage will fail-fast with a clear error
   to the user. They keep their credits (refund-on-fail covers it).
5. When HeyGen recovers, no action needed — users retry and it works.

If outage > 30 min, consider temporarily disabling the
`avatar_render` node in the canvas to stop users from queueing
renders that will fail. Hack: in `vercel.json` redirects, route
`/api/avatars/photo-render` to `/api/maintenance-503`. Or just let
users see the 502 and trust refund-on-fail.

---

## Free generation leak

**Symptom:** Sentry shows
`route:'<X>:consume', extra.kind:'free_generation_leak'`.

This means a user successfully generated something but our DB
`consume_credits` call returned `success:false`. They got the
generation for free.

**Investigate:**

The Sentry event has `userId`, `customerId`, `fee`, `error_code`. If
`error_code='insufficient'`, this was a race — they had insufficient
balance but the pre-check passed before another request consumed.

Decide:
- Tiny amount, single user, one-off: ignore.
- Pattern (>10 events/day from different users): the route's
  pre-check + deferred-consume pattern needs migration to
  `withCreditReservation`. Most routes are migrated; remaining ones
  are listed in `api/_lib/credits.js` doc comment.

**Reconcile:**

```sql
-- Find users who hit the leak in the last 24h. Pull their session
-- generations and back-charge if appropriate (judgment call —
-- consider whether this is your user's fault or our bug).
select customer_id, count(*), sum(extra->>'fee')::numeric / 100 as est_usd_lost
from -- (Sentry export, no DB table for this; pull from Sentry CSV)
group by customer_id;
```

---

## Vercel deploy failure

**Symptom:** Push to `main` shows red on Vercel. Deploy failed.

**Most common causes:**

1. **Edge runtime can't bundle a Node-only package** — e.g. `@sentry/node`
   imported (even via dynamic `await import()`) from a file that has
   `export const config = { runtime: 'edge' }`. Ours: `stripe-webhook.js`
   and `agent/chat.js`. Don't import the `api/_lib/sentry.js` helper from
   either file.
2. **Missing env var at build time** — Vite errors during `npm run build`
   if `import.meta.env.VITE_*` is read at module scope. Our build
   reads VITE_SUPABASE_URL etc — make sure those are set in Vercel
   for the environment being deployed.
3. **Native module (sharp / @resvg/resvg-js / @ffmpeg-installer)** — if
   the deploy log says "module not found" for one of these, check
   that the package is in `dependencies` (not `devDependencies`) and
   that `@vercel/node` resolved the right binary.

**Recover:**
1. Vercel UI → Deployments → click the failed one → see build logs.
2. If you can't fix in 5 min, **rollback** in Vercel UI → "Promote to
   Production" on the last green deploy.
3. Fix locally, `npm run build` to confirm clean, push.

---

## Comp credits

User-friendly support fix when something went wrong on our end.

```sql
-- Look up the customer
select id from public.billing_customers where user_id = '<auth.uid>';
-- Grant credits via the RPC (idempotent on action+ref_id).
select public.grant_credits(
  p_customer_id := '<billing_customers.id>',
  p_pool_type   := 'ai_tokens',          -- or video_units / voice_minutes
  p_amount      := 100000,               -- whatever amount
  p_action      := 'admin_comp',
  p_ref_id      := 'support-ticket-1234', -- so it's idempotent
  p_metadata    := '{"reason":"refund for failed render"}'::jsonb
);
```

Or use the **Admin → User Management** page (web UI) — same RPC under
the hood. It's safer because it logs the granted_by user_id in
metadata.

---

## Rolling back a migration

Most of our migrations are additive (alter table add column, create
index). Rolling those back is not destructive — you can drop the
column / index later.

For RLS policy changes (e.g. 0021 storage path isolation):
1. Revert the policy in Supabase Dashboard → Authentication →
   Policies, OR run the prior `create policy` block.
2. Push a follow-up migration restoring the old policy.

For trigger / function changes (e.g. 0015 sync_is_admin_to_jwt):
1. `drop trigger trg_sync_is_admin on public.user_profiles;`
2. Optionally `drop function public.sync_is_admin_to_app_metadata();`
3. The auth.users.raw_app_meta_data values stay populated; nothing
   breaks.

For grant_credits / consume_credits / set_pool_grants — DO NOT
modify these without testing. They are SECURITY DEFINER functions
that the entire credit system depends on. Test changes in a Supabase
branch first.

---

## Periodic health checks

### Daily (5 min)

1. **Sentry** — check error rate. Free-tier limit is 5K/month;
   sustained spike is the warning sign of a regression.
2. **`/api/health`** — should return `{ ok: true, ... }` with
   green checks for DB + cron status.
3. **Stripe webhook freshness:**
   ```sql
   select max(created_at) from stripe_events;
   ```
   Should be within the last hour during business hours.

### Weekly

1. **Free generation leaks**:
   ```sql
   select action, count(*), sum(abs(delta)) as units_lost
   from credit_transactions
   where action like 'refund:%'
     and created_at > now() - interval '7 days'
   group by action
   order by 3 desc;
   ```
   If any single action has thousands of refunds/week, the consume
   pattern needs another audit.

2. **Stuck rows**:
   ```sql
   select count(*) from avatar_renders
   where status in ('generating_clips','pending','processing')
     and created_at < now() - interval '1 hour';
   ```
   Should be near zero (the 15-min cron sweeps them).

3. **Stripe events with errors**:
   ```sql
   select event_type, count(*), max(error) as sample_error
   from stripe_events
   where error is not null and processed_at is null
     and created_at > now() - interval '7 days'
   group by event_type;
   ```
   Should be empty. If not, replay them from Stripe Dashboard.

### Monthly

1. **Affiliate close cron** ran (`/api/admin/affiliates-close`):
   ```sql
   select count(*) from affiliate_commissions
   where status = 'pending'
     and invoice_paid_at < now() - interval '31 days';
   ```
   Should be zero. If not, the cron's failing — manually trigger.

2. **Database size + index bloat** — Supabase Dashboard → Database →
   Storage. Watch for unexpected growth (e.g. credit_transactions
   table > 1 GB indicates we're not vacuuming or there's a write loop).

---

## Useful one-liners

```bash
# Tail Vercel function logs
vercel logs --follow

# List unprocessed Stripe events
curl -s -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  "$SUPABASE_URL/rest/v1/stripe_events?processed_at=is.null&select=stripe_event_id,event_type,error&order=created_at.desc"

# Manual cron fire
curl -X POST https://www.scalesolo.ai/api/cron/sweep-stale-renders \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://www.scalesolo.ai/api/admin/affiliates-close \
  -H "Authorization: Bearer $CRON_SECRET"
```
