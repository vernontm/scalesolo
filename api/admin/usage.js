// /api/admin/usage — admin-only credit usage breakdown.
//
// Query:
//   ?window=24h | 7d | 30d   (default 7d)
//
// Returns:
//   {
//     window: '7d',
//     since: '2026-05-02T18:00:00.000Z',
//     totals: { ai_tokens: 1234567, video_units: 89, voice_minutes: 0, est_usd: 12.34 },
//     by_action: [
//       { action, pool_type, count, units, est_usd },
//       …
//     ],
//     by_user: [{ user_id, email?, total_usd, ai_tokens, video_units, voice_minutes }],
//   }
//
// Cost is an estimate based on the topup price-per-unit (api/_lib/credits.js
// TOPUP_OPTIONS). It's intentionally a single per-pool rate — actual COGS
// is much lower; this is meant to flag which actions are eating which
// pools so we can spot abuse / runaway pipelines.

import { setCors, requireAdmin, supaFetch } from '../_lib/supabase.js'

// Per-pool USD cost we attribute to one consumed unit. Anchor: cheapest
// topup option in TOPUP_OPTIONS so we don't undercount.
const COST_PER_UNIT_USD = {
  ai_tokens:     10 / 100_000,   // $10 / 100K tokens
  video_units:   20 / 10,        // $20 / 10 video units
  voice_minutes: 0,              // not yet sold
}

const WINDOWS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAdmin(req, res)
  if (!auth) return

  const win = (req.query.window || '7d').toString()
  const ms = WINDOWS[win] || WINDOWS['7d']
  const since = new Date(Date.now() - ms).toISOString()

  try {
    // Pull all consumption rows in the window. Negative-only deltas are
    // the consumption events (positive deltas are grants / topups).
    const rows = await supaFetch(
      `credit_transactions?delta=lt.0&created_at=gte.${encodeURIComponent(since)}&select=action,pool_type,delta,customer_id,profile_id,created_at&order=created_at.desc&limit=5000`
    )

    // Aggregate by action.
    const byActionKey = new Map()
    let aiTokensTotal = 0, videoUnitsTotal = 0, voiceMinutesTotal = 0
    const byUser = new Map()
    for (const r of rows) {
      const units = Math.abs(Number(r.delta) || 0)
      const cost = units * (COST_PER_UNIT_USD[r.pool_type] || 0)
      const key = `${r.action}|${r.pool_type}`
      const cur = byActionKey.get(key) || { action: r.action, pool_type: r.pool_type, count: 0, units: 0, est_usd: 0 }
      cur.count += 1
      cur.units += units
      cur.est_usd += cost
      byActionKey.set(key, cur)
      if (r.pool_type === 'ai_tokens') aiTokensTotal += units
      else if (r.pool_type === 'video_units') videoUnitsTotal += units
      else if (r.pool_type === 'voice_minutes') voiceMinutesTotal += units

      const cid = r.customer_id || 'unknown'
      const u = byUser.get(cid) || { customer_id: cid, total_usd: 0, ai_tokens: 0, video_units: 0, voice_minutes: 0 }
      u.total_usd += cost
      if (r.pool_type === 'ai_tokens') u.ai_tokens += units
      else if (r.pool_type === 'video_units') u.video_units += units
      else if (r.pool_type === 'voice_minutes') u.voice_minutes += units
      byUser.set(cid, u)
    }

    const byAction = Array.from(byActionKey.values())
      .sort((a, b) => b.est_usd - a.est_usd)
    const byUserList = Array.from(byUser.values())
      .sort((a, b) => b.total_usd - a.total_usd)
      .slice(0, 50)

    // Resolve customer_id → user email (best-effort). One round trip.
    if (byUserList.length) {
      try {
        const ids = byUserList.map((u) => u.customer_id).filter((x) => x !== 'unknown')
        if (ids.length) {
          const customers = await supaFetch(
            `billing_customers?id=in.(${ids.map((i) => encodeURIComponent(i)).join(',')})&select=id,user_id,email`
          )
          const cmap = new Map(customers.map((c) => [c.id, c]))
          for (const u of byUserList) {
            const c = cmap.get(u.customer_id)
            if (c) {
              u.user_id = c.user_id
              u.email = c.email
            }
          }
        }
      } catch (e) {
        console.warn('admin/usage: customer lookup failed', e.message)
      }
    }

    const est_usd = aiTokensTotal * COST_PER_UNIT_USD.ai_tokens
                  + videoUnitsTotal * COST_PER_UNIT_USD.video_units
                  + voiceMinutesTotal * COST_PER_UNIT_USD.voice_minutes

    return res.status(200).json({
      window: win,
      since,
      totals: {
        ai_tokens: aiTokensTotal,
        video_units: videoUnitsTotal,
        voice_minutes: voiceMinutesTotal,
        est_usd,
        events: rows.length,
      },
      by_action: byAction,
      by_user: byUserList,
    })
  } catch (err) {
    console.error('admin/usage error:', err?.stack || err)
    return res.status(500).json({ error: err.message })
  }
}
