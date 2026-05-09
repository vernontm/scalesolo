// /api/health — uptime / health check.
//
// Default GET → fast liveness check ({ ok: true }). Suitable for
// uptime monitors that just need a 200.
//
// GET ?deep=1 → adds DB connectivity check + cron freshness signals.
// Slower (one DB round trip) but useful for diagnosis pages and
// daily health checks. Public by design.
//
// Never exposes secrets or row data. Returns booleans only.

import { setCors, supaFetch } from './_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const base = {
    ok: true,
    service: 'scalesolo',
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || '0.1.0',
    timestamp: new Date().toISOString(),
    region: process.env.VERCEL_REGION || 'local',
  }

  if (req.query.deep !== '1') {
    return res.status(200).json(base)
  }

  // Deep checks. Each is wrapped so a single failure doesn't fail the
  // whole response — uptime monitors can decide based on the
  // individual flags.
  const checks = {}

  // Supabase reachability — cheap select + count probe.
  try {
    const t0 = Date.now()
    await supaFetch('user_profiles?select=id&limit=1')
    checks.supabase = { ok: true, latency_ms: Date.now() - t0 }
  } catch (e) {
    checks.supabase = { ok: false, error: e.message?.slice(0, 200) }
  }

  // Recent Stripe webhook activity (signals webhook delivery is healthy).
  try {
    const rows = await supaFetch(
      `stripe_events?select=created_at&order=created_at.desc&limit=1`
    )
    const last = rows?.[0]?.created_at
    const hoursAgo = last ? (Date.now() - new Date(last).getTime()) / 3_600_000 : null
    checks.stripe_webhook = {
      ok: true,                              // we don't fail here — quiet days are normal
      last_event_at: last || null,
      hours_since: hoursAgo == null ? null : Math.round(hoursAgo * 10) / 10,
    }
  } catch (e) {
    checks.stripe_webhook = { ok: false, error: e.message?.slice(0, 200) }
  }

  // Stuck-render canary. If any rows are >2h old in a transient state,
  // the sweeper cron is broken or HeyGen polling is wedged.
  try {
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const rows = await supaFetch(
      `avatar_renders?status=in.(generating_clips,pending,processing,queued,submitted)` +
      `&created_at=lt.${encodeURIComponent(cutoff)}&select=id&limit=1`
    )
    checks.stuck_renders = { ok: rows.length === 0, sample_present: rows.length > 0 }
  } catch (e) {
    checks.stuck_renders = { ok: false, error: e.message?.slice(0, 200) }
  }

  // Recent unprocessed-with-error stripe_events (webhook handler bugs).
  try {
    const rows = await supaFetch(
      `stripe_events?processed_at=is.null&error=not.is.null&select=stripe_event_id&limit=10`
    )
    checks.failed_webhook_events = {
      ok: rows.length === 0,
      pending_count: rows.length,
    }
  } catch (e) {
    checks.failed_webhook_events = { ok: false, error: e.message?.slice(0, 200) }
  }

  // Roll up. Top-level ok = all subchecks ok.
  const allOk = Object.values(checks).every((c) => c.ok !== false)
  return res.status(allOk ? 200 : 503).json({
    ...base,
    ok: allOk,
    checks,
  })
}
