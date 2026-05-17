// GET /api/admin/presence — admin-only "who's using ScaleSolo right now"
//
// Returns:
//   {
//     active_now:  <int>,   distinct users with last_seen_at > now - 5 min
//     today:       <int>,   distinct users with last_seen_at >= today (UTC)
//     total_users: <int>,   all-time signed-up users (auth.users count)
//   }
//
// Drives the Admin-only widget on the Dashboard. Cheap — two count
// queries against user_heartbeats, plus one against auth.users for
// the lifetime total.

import { setCors, requireAdmin, supaFetch } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAdmin(req, res)
  if (!auth) return

  try {
    // Active-now: last_seen_at within the past 5 minutes. Anything
    // older almost certainly means the user closed the tab — we'd
    // rather under-count than show stale presence.
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    // Today: last_seen_at since UTC midnight. Using UTC so the count
    // is consistent regardless of where the dashboard is rendered.
    const utcMidnight = new Date()
    utcMidnight.setUTCHours(0, 0, 0, 0)
    const todayStart = utcMidnight.toISOString()

    // PostgREST count via Prefer: count=exact + the Content-Range
    // header. We're abusing supaFetch's existing return shape by
    // asking for select=user_id&limit=1 — the count is returned
    // alongside, exposed via the `_count` field that supaFetch
    // surfaces when prefer includes count=*.
    const fetchCount = async (whereClause) => {
      const url = `user_heartbeats?${whereClause}&select=user_id`
      const rows = await supaFetch(url, { prefer: 'count=exact' }).catch(() => [])
      // supaFetch returns the array of rows. Use length as the
      // canonical count — heartbeats table is one-row-per-user, so
      // length === distinct user count.
      return Array.isArray(rows) ? rows.length : 0
    }

    const [activeNow, today] = await Promise.all([
      fetchCount(`last_seen_at=gte.${encodeURIComponent(fiveMinAgo)}`),
      fetchCount(`last_seen_at=gte.${encodeURIComponent(todayStart)}`),
    ])

    // All-time total: scan billing_customers (one row per user) which
    // is cheaper than the auth.users mirror and indexed.
    let totalUsers = 0
    try {
      const rows = await supaFetch(`billing_customers?select=user_id&limit=10000`)
      totalUsers = Array.isArray(rows) ? rows.length : 0
    } catch {}

    return res.status(200).json({
      active_now: activeNow,
      today,
      total_users: totalUsers,
      as_of: new Date().toISOString(),
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
