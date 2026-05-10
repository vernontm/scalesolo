// /api/content/stats — lightweight per-profile counters for the
// dashboard. Returns counts for: created this month, shipped this
// month, scheduled, drafts, pending approval. We use HEAD requests
// against PostgREST with prefer=count=exact so each query is a
// single row count, not a full row fetch.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

async function count(query) {
  // PostgREST count via prefer=count=exact + Range: 0-0. Returns the
  // total in the Content-Range header.
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    method: 'HEAD',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  })
  if (!r.ok) return 0
  const cr = r.headers.get('content-range') || ''
  const m = cr.match(/\/(\d+)$/)
  return m ? parseInt(m[1], 10) : 0
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  const profileId = req.query.profile_id
  if (!profileId) return res.status(400).json({ error: 'profile_id required' })
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileId)) {
    return res.status(400).json({ error: 'invalid profile_id' })
  }
  await assertProfileAccess(auth.user.id, profileId)

  try {
    const monthStart = new Date()
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
    const since = encodeURIComponent(monthStart.toISOString())
    const base = `content_scripts?profile_id=eq.${profileId}`
    const [createdMonth, shippedMonth, scheduled, drafts, pendingApproval] = await Promise.all([
      count(`${base}&created_at=gte.${since}`),
      count(`${base}&status=eq.posted&updated_at=gte.${since}`),
      count(`${base}&status=eq.scheduled`),
      count(`${base}&status=eq.draft`),
      count(`${base}&approval_status=eq.pending`),
    ])

    return res.status(200).json({
      created_month: createdMonth,
      shipped_month: shippedMonth,
      scheduled,
      drafts,
      pending_approval: pendingApproval,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
