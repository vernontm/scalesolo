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

  // Upload-Post engagement metrics. Three endpoints in play:
  //   1. /api/analytics/{username}?platforms=… — account-level summaries.
  //   2. /api/uploadposts/total-impressions/{username}?period=… — single
  //      dedup'd impressions number across all platforms.
  //   3. /api/uploadposts/post-analytics/{request_id} — per-post engagement.
  // Each is best-effort; failures fall through silently.
  let uploadpost_stats = null
  let total_impressions = null
  let recent_post_metrics = null
  try {
    const username = await resolveUploadpostUser(profileId)
    const platforms = Object.keys(platformCounts)

    // (1) Account-level platform analytics — single call across every
    // platform the brand actually publishes to.
    if (platforms.length) {
      try {
        const path = `/api/analytics/${encodeURIComponent(username)}?platforms=${encodeURIComponent(platforms.join(','))}`
        const data = await uploadpost(path)
        if (data && typeof data === 'object') uploadpost_stats = data
      } catch (e) {
        console.warn('uploadpost /api/analytics failed:', e?.message)
      }
    }

    // (2) Aggregate impressions for the matching window. Map our window
    // to Upload-Post's `period` param (closest equivalent).
    try {
      const period = win === '7d' ? 'last_week' : win === '30d' ? 'last_month' : 'last_3months'
      const path = `/api/uploadposts/total-impressions/${encodeURIComponent(username)}?period=${period}`
      const data = await uploadpost(path)
      if (data?.success || data?.total_impressions != null) {
        total_impressions = {
          total: Number(data.total_impressions) || 0,
          per_platform: data.per_platform || {},
          per_day: data.per_day || {},
        }
      }
    } catch (e) {
      console.warn('uploadpost total-impressions failed:', e?.message)
    }

    // (3) Per-post metrics for the most recent ~20 published posts that
    // have a request_id on file. Capped + parallel; one failure doesn't
    // poison the rest.
    const withReq = rows.filter((r) => r.uploadpost_request_id).slice(0, 20)
    if (withReq.length) {
      const fetched = {}
      await Promise.all(withReq.map(async (r) => {
        try {
          const data = await uploadpost(`/api/uploadposts/post-analytics/${encodeURIComponent(r.uploadpost_request_id)}`)
          if (data?.success && data?.platforms) {
            // Flatten to a per-script summary of total likes/views/etc.
            const totals = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 }
            for (const platformData of Object.values(data.platforms)) {
              const m = platformData?.post_metrics || {}
              for (const k of Object.keys(totals)) {
                const v = Number(m[k] ?? m[`${k}_count`] ?? 0) || 0
                totals[k] += v
              }
            }
            fetched[r.id] = totals
          }
        } catch {}
      }))
      if (Object.keys(fetched).length) recent_post_metrics = fetched
    }
  } catch (e) {
    console.warn('uploadpost analytics block failed:', e?.message)
  }

  // Roll per-post metrics into headline totals so the dashboard cards
  // have something to show even before the user drills into a post.
  let totals = null
  if (recent_post_metrics) {
    totals = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 }
    for (const m of Object.values(recent_post_metrics)) {
      for (const k of Object.keys(totals)) totals[k] += (Number(m[k]) || 0)
    }
  }

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
      metrics: recent_post_metrics?.[r.id] || null,
    })),
    uploadpost_stats,
    total_impressions,
    engagement_totals: totals,
  }
}

function isoWeekKey(d) {
  // Year + ISO week. Cheap-and-cheerful: Monday-of-week in YYYY-MM-DD.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = date.getUTCDay() || 7
  if (day !== 1) date.setUTCDate(date.getUTCDate() - (day - 1))
  return date.toISOString().slice(0, 10)
}
