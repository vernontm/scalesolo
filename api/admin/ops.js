// /api/admin/ops — single endpoint that aggregates the "what's stuck"
// signals admins need to check daily. Maps 1:1 to the queries in
// RUNBOOK.md. Deliberately public-shape (no payloads / PII), just
// counts + sample ids so the dashboard can link into the relevant
// page or RUNBOOK section.

import { setCors, requireAdmin, supaFetch } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireAdmin(req, res)
  if (!auth) return

  // Cutoffs.
  const oneHourAgo  = new Date(Date.now() -      60 * 60 * 1000).toISOString()
  const oneDayAgo   = new Date(Date.now() -  24 * 60 * 60 * 1000).toISOString()
  const sevenDayAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  try {
    // Run all checks in parallel — total request latency = slowest.
    const [
      failedWebhooks,
      lastWebhookRow,
      stuckRenders,
      stuckSchedules,
      recentRefunds,
      recentConsumes,
      pendingAffiliateOld,
    ] = await Promise.all([
      // Failed-but-unprocessed Stripe events. One sample id per event_type.
      supaFetch(
        `stripe_events?processed_at=is.null&error=not.is.null` +
        `&select=stripe_event_id,event_type,error,created_at,last_attempt_at` +
        `&order=created_at.desc&limit=20`
      ).catch(() => []),
      // Most recent stripe event of any kind (signals webhook delivery
      // is healthy at all).
      supaFetch(
        `stripe_events?select=stripe_event_id,event_type,created_at,processed_at` +
        `&order=created_at.desc&limit=1`
      ).catch(() => []),
      // Avatar renders stuck in transient states for >2 hours (cron
      // sweeper should have caught these — if anything's here, the
      // cron is broken).
      supaFetch(
        `avatar_renders?status=in.(generating_clips,pending,processing,queued,submitted)` +
        `&created_at=lt.${encodeURIComponent(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())}` +
        `&select=id,status,profile_id,created_at,heygen_video_id` +
        `&order=created_at.asc&limit=20`
      ).catch(() => []),
      // Scheduled posts past their fire time without a request_id (=
      // the pre-fix bug rows; should be near zero post-launch).
      supaFetch(
        `content_scripts?status=eq.scheduled` +
        `&scheduled_datetime=lt.${encodeURIComponent(new Date().toISOString())}` +
        `&uploadpost_request_id=is.null` +
        `&select=id,title,scheduled_datetime,profile_id` +
        `&order=scheduled_datetime.desc&limit=20`
      ).catch(() => []),
      // Refund volume in the last 24h. Spike here = upstream provider
      // (HeyGen / KIE) is failing and we're auto-refunding heavily.
      supaFetch(
        `credit_transactions?action=like.refund:%25&created_at=gte.${encodeURIComponent(oneDayAgo)}` +
        `&select=action,delta,created_at,customer_id&order=created_at.desc&limit=200`
      ).catch(() => []),
      // Consume volume in the last 24h. For ratio context against refunds.
      supaFetch(
        `credit_transactions?action=like.consume:%25&delta=lt.0&created_at=gte.${encodeURIComponent(oneDayAgo)}` +
        `&select=action&limit=2000`
      ).catch(() => []),
      // Affiliate commissions stuck pending past the 30-day refund
      // window — affiliates-close cron should have approved them.
      supaFetch(
        `affiliate_commissions?status=eq.pending` +
        `&invoice_paid_at=lt.${encodeURIComponent(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString())}` +
        `&select=id&limit=10`
      ).catch(() => []),
    ])

    // Roll refunds up by action.
    const refundByAction = {}
    for (const r of recentRefunds || []) {
      const k = r.action
      if (!refundByAction[k]) refundByAction[k] = { count: 0, units: 0 }
      refundByAction[k].count += 1
      refundByAction[k].units += Math.abs(Number(r.delta) || 0)
    }
    // Consume counts by action — for ratio.
    const consumeCountByAction = {}
    for (const r of recentConsumes || []) {
      consumeCountByAction[r.action] = (consumeCountByAction[r.action] || 0) + 1
    }

    const lastWebhookAt = lastWebhookRow?.[0]?.created_at || null
    const hoursSinceLastWebhook = lastWebhookAt
      ? Math.round(((Date.now() - new Date(lastWebhookAt).getTime()) / 3_600_000) * 10) / 10
      : null

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      stripe: {
        last_event_at: lastWebhookAt,
        hours_since_last_event: hoursSinceLastWebhook,
        failed_unprocessed_count: failedWebhooks.length,
        failed_unprocessed_sample: failedWebhooks.slice(0, 5),
      },
      stuck_renders: {
        count: stuckRenders.length,
        sample: stuckRenders.slice(0, 5),
        cron_path: '/api/cron/sweep-stale-renders',
      },
      stuck_scheduled_posts: {
        count: stuckSchedules.length,
        sample: stuckSchedules.slice(0, 5),
        note: 'NULL uploadpost_request_id means pre-launch bug; manual flip required.',
      },
      refunds_24h: {
        total: (recentRefunds || []).length,
        by_action: refundByAction,
        consume_counts_for_ratio: consumeCountByAction,
      },
      affiliates: {
        stuck_pending_past_window: pendingAffiliateOld.length,
        cron_path: '/api/admin/affiliates-close',
      },
      windows: {
        one_hour_ago: oneHourAgo,
        one_day_ago: oneDayAgo,
        seven_day_ago: sevenDayAgo,
      },
    })
  } catch (err) {
    console.error('admin/ops error:', err?.stack || err)
    return res.status(500).json({ error: err.message })
  }
}
