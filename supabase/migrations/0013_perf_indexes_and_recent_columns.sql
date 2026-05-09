-- Catch-up migration:
--   * commit columns I added via MCP earlier (brand_cta, notification_prefs)
--     so new envs bootstrap with the right shape
--   * add missing indexes flagged by the perf audit
-- All operations are idempotent so re-running this on prod is a no-op.

-- ── columns I added via MCP for batches 2–3 ──────────────────────────────
alter table public.profiles
  add column if not exists brand_cta text;

alter table public.user_profiles
  add column if not exists notification_prefs jsonb not null default
    '{"run_done":true,"post_scheduled":true,"post_published":true,"post_failed":true,"credits_low":true}'::jsonb;

-- ── indexes flagged by the audit ─────────────────────────────────────────
-- /api/admin/users joins profile_access by user_id; existing schema only
-- indexes (profile_id). Without this, a 5k-row join scans the whole table.
create index if not exists profile_access_user_idx
  on public.profile_access (user_id);

-- /api/admin/usage scans credit_transactions filtered ONLY by delta < 0
-- and created_at >= cutoff. The existing customer-first composite can't
-- serve this query plan. A partial index keyed by created_at covering
-- only consumption rows is small and exactly the right shape.
create index if not exists credit_tx_consumption_idx
  on public.credit_transactions (created_at desc)
  where delta < 0;

-- /api/analytics cache lookup filters by (profile_id, period, updated_at).
create index if not exists analytics_snapshots_period_updated_idx
  on public.analytics_snapshots (profile_id, period, updated_at desc);
