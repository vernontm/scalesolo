// GET /api/admin/presence — admin-only "who's using ScaleSolo right now"
//
// Returns:
//   {
//     active_now:      <int>,   distinct sessions w/ heartbeat in last 5 min
//     active_signedin: <int>,   subset of active_now that's authenticated
//     today:           <int>,   distinct sessions w/ heartbeat since UTC midnight
//     today_signedin:  <int>,   subset of today that's authenticated
//     total_users:     <int>,   lifetime signups (billing_customers count)
//     as_of:           ISO ts
//   }
//
// Counts cover TOTAL traffic: anonymous landing-page visitors + signed-
// in users together. The signed-in subsets are extra columns so the
// admin can see both "how big is the funnel right now" and "how many
// of those are paying users."

import { setCors, requireAdmin, supaFetch } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAdmin(req, res)
  if (!auth) return

  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const utcMidnight = new Date()
    utcMidnight.setUTCHours(0, 0, 0, 0)
    const todayStart = utcMidnight.toISOString()

    // Each fetch is "give me the rows matching this filter" then
    // .length. PostgREST count headers are finicky over our supaFetch
    // wrapper; using length keeps it simple and the row volume is
    // small enough (one row per session). Limit caps the response
    // at 5000 to keep payload bounded — the counter says "5000+" if
    // we ever cross that.
    const fetchRows = async (where) => {
      const url = `user_heartbeats?${where}&select=user_id&limit=5000`
      const rows = await supaFetch(url).catch(() => [])
      return Array.isArray(rows) ? rows : []
    }

    const [activeRows, todayRows] = await Promise.all([
      fetchRows(`last_seen_at=gte.${encodeURIComponent(fiveMinAgo)}`),
      fetchRows(`last_seen_at=gte.${encodeURIComponent(todayStart)}`),
    ])

    const countSignedIn = (rows) => rows.filter((r) => !!r.user_id).length

    let totalUsers = 0
    try {
      const rows = await supaFetch(`billing_customers?select=user_id&limit=10000`)
      totalUsers = Array.isArray(rows) ? rows.length : 0
    } catch {}

    return res.status(200).json({
      active_now: activeRows.length,
      active_signedin: countSignedIn(activeRows),
      today: todayRows.length,
      today_signedin: countSignedIn(todayRows),
      total_users: totalUsers,
      as_of: new Date().toISOString(),
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
