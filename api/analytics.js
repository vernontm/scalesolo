// /api/analytics — per-profile content + publishing analytics.
//
//   GET ?profile_id=…&window=7d|30d|90d
//
// Returns a derived summary from content_scripts (posts published, by
// platform, weekly trend, top titles) plus optional Upload-Post
// engagement metrics if the API responds. Cached in
// public.analytics_snapshots so a re-load inside the TTL window doesn't
// fan out a fresh fetch.
//
// First-pass scope: published-volume and platform mix. Engagement
// (views / likes / shares) is fetched best-effort from Upload-Post —
// the function logs a warning and returns the volume summary alone if
// the upstream call fails or isn't enabled.

import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'
import { resolveUploadpostUser, uploadpost } from './_lib/uploadpost.js'

const TTL_MIN_BY_WINDOW = { '7d': 30, '30d': 60, '90d': 120 }
const WINDOW_DAYS = { '7d': 7, '30d': 30, '90d': 90 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  const profileId = req.query.profile_id
  if (!profileId) return res.status(400).json({ error: 'profile_id required' })
  await assertProfileAccess(auth.user.id, profileId)
  const win = WINDOW_DAYS[req.query.window] ? req.query.window : '30d'
  const force = req.query.refresh === '1'

  try {
    // Cache: hit if a snapshot for this profile + window exists within
    // the TTL. Otherwise compute fresh.
    if (!force) {
      const ttlMin = TTL_MIN_BY_WINDOW[win]
      const cutoff = new Date(Date.now() - ttlMin * 60 * 1000).toISOString()
      const cached = await supaFetch(
        `analytics_snapshots?profile_id=eq.${profileId}&period=eq.${win}&updated_at=gte.${encodeURIComponent(cutoff)}&order=updated_at.desc&limit=1&select=*`
      ).catch(() => [])
      if (cached?.[0]) {
        return res.status(200).json({ ...cached[0].analytics_data, cached: true, cached_at: cached[0].updated_at })
      }
    }

    const summary = await computeSummary(profileId, win)

    // Upsert snapshot. Same profile + period + date overwrites.
    try {
      const today = new Date().toISOString().slice(0, 10)
      const existing = await supaFetch(
        `analytics_snapshots?profile_id=eq.${profileId}&period=eq.${win}&snapshot_date=eq.${today}&select=id`
      )
      const row = {
        profile_id: profileId,
        snapshot_date: today,
        period: win,
        platforms: 'all',
        analytics_data: summary,
        impressions_data: null,
        updated_at: new Date().toISOString(),
      }
      if (existing?.[0]) {
        await supaFetch(`analytics_snapshots?id=eq.${existing[0].id}`, {
          method: 'PATCH', body: row, prefer: 'return=minimal',
        })
      } else {
        await supaFetch('analytics_snapshots', {
          method: 'POST', body: [row], prefer: 'return=minimal',
        })
      }
    } catch (e) {
      console.warn('analytics_snapshots upsert failed:', e.message)
    }

    return res.status(200).json({ ...summary, cached: false })
  } catch (err) {
    console.error('analytics error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}

async function computeSummary(profileId, win) {
  const days = WINDOW_DAYS[win]
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  // Pull published posts in window. Status=posted is the canonical "live"
  // state; scheduled-but-not-yet-posted rows aren't counted.
  const rows = await supaFetch(
    `content_scripts?profile_id=eq.${profileId}&status=eq.posted&created_at=gte.${encodeURIComponent(since)}&select=id,title,caption,platforms,media_type,created_at,updated_at,uploadpost_request_id&order=created_at.desc&limit=500`
  )

  // Volume by platform.
  const platformCounts = {}
  for (const r of rows) {
    const ps = Array.isArray(r.platforms) ? r.platforms : []
    for (const p of ps) platformCounts[p] = (platformCounts[p] || 0) + 1
  }

  // Posts per week bucket (last `days` days).
  const buckets = {}
  for (const r of rows) {
    const d = new Date(r.created_at || r.updated_at)
    const wk = isoWeekKey(d)
    buckets[wk] = (buckets[wk] || 0) + 1
  }
  // Build a continuous series so the chart doesn't have gaps.
  const series = []
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 7)) {
    const k = isoWeekKey(d)
    series.push({ week: k, posts: buckets[k] || 0 })
  }

  // Best-effort: Upload-Post profile stats (top-level account summary).
  // Failures are silent — we still return the volume summary.
  let uploadpost_stats = null
  try {
    const username = await resolveUploadpostUser(profileId)
    // The Upload-Post API exposes per-platform analytics under
    // /api/uploadposts/{platform}/analytics?profile=... Skip silently if
    // anything errors; not every plan/account has analytics enabled.
    const platforms = Object.keys(platformCounts)
    const fetched = {}
    await Promise.all(platforms.map(async (p) => {
      try {
        const path = `/api/uploadposts/analytics/${encodeURIComponent(p)}?profile=${encodeURIComponent(username)}&days=${days}`
        const data = await uploadpost(path)
        fetched[p] = data || null
      } catch {}
    }))
    if (Object.keys(fetched).length) uploadpost_stats = fetched
  } catch {}

  return {
    window: win,
    since,
    total_posts: rows.length,
    platform_counts: platformCounts,
    series,
    recent_posts: rows.slice(0, 20).map((r) => ({
      id: r.id,
      title: r.title,
      caption: (r.caption || '').slice(0, 200),
      platforms: r.platforms || [],
      media_type: r.media_type,
      created_at: r.created_at,
    })),
    uploadpost_stats,
  }
}

function isoWeekKey(d) {
  // Year + ISO week. Cheap-and-cheerful: Monday-of-week in YYYY-MM-DD.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = date.getUTCDay() || 7
  if (day !== 1) date.setUTCDate(date.getUTCDate() - (day - 1))
  return date.toISOString().slice(0, 10)
}
