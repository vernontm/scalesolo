// GET /api/social/growth?profile_id=…
//
// Month-over-month growth for the active brand profile. Returns:
//
//   {
//     this_month: { label, posts, impressions, views, likes, comments, shares },
//     last_month: { ...same },
//     deltas:     { posts: { abs, pct }, impressions: {...}, ... },
//     per_platform: {
//       tiktok:    { this_month, last_month, delta, followers?, connected },
//       instagram: { ... },
//       ...
//     },
//     connected: ['tiktok', 'instagram', ...],
//     generated_at: ISO,
//   }
//
// Data flows from THREE sources, blended with the most-trusted value
// winning:
//   1. content_scripts (status='posted') — exact monthly post counts
//      because WE wrote those rows when scheduling.
//   2. Upload-Post /api/uploadposts/total-impressions?period=last_month
//      — Upload-Post's aggregate impressions for the last 30d. We call
//      it twice (last_month, last_3months) and subtract to derive a
//      previous-month figure. Not perfect (last_3months = last 90d,
//      not "month before last") but close enough for MoM headline
//      numbers. Falls through silently on API failure.
//   3. Upload-Post /api/analytics/{username}?platforms=… — per-platform
//      engagement totals. Used for the per-platform tiles. Follower
//      counts surface here when the platform exposes them.
//
// Cache: 1 hour in analytics_snapshots under period='mom'. Manual
// refresh via ?refresh=1.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { resolveUploadpostUser, uploadpost } from '../_lib/uploadpost.js'

const TTL_MIN = 60

function monthBounds(refDate, offsetMonths = 0) {
  // Returns ISO start (inclusive) + end (exclusive) for the calendar
  // month containing refDate + offsetMonths. Uses UTC so the comparison
  // is timezone-invariant — close enough for headline numbers, and
  // sidesteps per-brand TZ config until we need it.
  const d = new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth() + offsetMonths, 1))
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  return {
    start: d.toISOString(),
    end:   next.toISOString(),
    label: d.toLocaleString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
  }
}

function delta(curr, prev) {
  const c = Number(curr) || 0
  const p = Number(prev) || 0
  const abs = c - p
  // pct undefined when prev = 0 (avoid div-by-zero infinity). Callers
  // render that as "new" or "—" in the UI.
  const pct = p > 0 ? (abs / p) * 100 : null
  return { abs, pct }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  const profileId = req.query.profile_id
  if (!profileId) return res.status(400).json({ error: 'profile_id required' })
  await assertProfileAccess(auth.user.id, profileId)
  const force = req.query.refresh === '1'

  try {
    // Cache check — period='mom' is the dedicated slot. 1h TTL because
    // Upload-Post syncs through often enough that staler-than-1h data
    // misleads the user on whether their afternoon push moved the needle.
    if (!force) {
      const cutoff = new Date(Date.now() - TTL_MIN * 60 * 1000).toISOString()
      const cached = await supaFetch(
        `analytics_snapshots?profile_id=eq.${profileId}&period=eq.mom&updated_at=gte.${encodeURIComponent(cutoff)}&order=updated_at.desc&limit=1&select=*`
      ).catch(() => [])
      if (cached?.[0]) {
        return res.status(200).json({ ...cached[0].analytics_data, cached: true, cached_at: cached[0].updated_at })
      }
    }

    const now = new Date()
    const tm = monthBounds(now, 0)   // this month
    const lm = monthBounds(now, -1)  // last month

    // 1. Post counts (our own data — most trustworthy).
    const postsByMonth = async (boundsRange) => {
      const rows = await supaFetch(
        `content_scripts?profile_id=eq.${profileId}&status=eq.posted` +
        `&created_at=gte.${encodeURIComponent(boundsRange.start)}` +
        `&created_at=lt.${encodeURIComponent(boundsRange.end)}` +
        `&select=id,platforms`
      ).catch(() => [])
      const platformCounts = {}
      for (const r of rows) {
        const ps = Array.isArray(r.platforms) ? r.platforms : []
        for (const p of ps) platformCounts[p] = (platformCounts[p] || 0) + 1
      }
      return { total: rows.length, by_platform: platformCounts }
    }
    const [thisMonthPosts, lastMonthPosts] = await Promise.all([
      postsByMonth(tm),
      postsByMonth(lm),
    ])

    // 2. Upload-Post impressions (best-effort).
    //
    // Their `period` values are rolling windows, not calendar months.
    // We derive "last calendar month" via: last_3months - last_month
    // ≈ 60d before. Imperfect but the only signal Upload-Post exposes.
    // Headline impressions for THIS month = last_month period (=30d
    // back-window, closest to "this month so far" for an end-of-month
    // user). Numbers drift mid-month; that's fine.
    let thisImpressions = null
    let lastImpressions = null
    let perPlatformImpr = null
    let uploadpostStats = null
    let connectedPlatforms = []
    try {
      const username = await resolveUploadpostUser(profileId)

      // Profile fetch — surfaces the connected social_accounts map so
      // we know which platforms to query and which to show as "not
      // connected" in the UI.
      try {
        const prof = await uploadpost(`/api/uploadposts/users/${encodeURIComponent(username)}`)
        const accts = prof?.profile?.social_accounts || prof?.social_accounts || {}
        connectedPlatforms = Object.keys(accts).filter((k) => {
          const v = accts[k]
          // Truthy account entry — either { username: '...' } or just truthy.
          return v && (typeof v === 'object' ? Object.keys(v).length > 0 : true)
        })
      } catch (e) {
        console.warn('[growth] uploadpost user profile fetch failed:', e?.message)
      }

      const platformsQ = connectedPlatforms.length
        ? `?platforms=${encodeURIComponent(connectedPlatforms.join(','))}`
        : ''

      // Parallel: per-platform stats + last_month impressions + last_3months
      // impressions. Each independently best-effort.
      const [accountStats, imprLastMonth, imprLast3] = await Promise.all([
        connectedPlatforms.length
          ? uploadpost(`/api/analytics/${encodeURIComponent(username)}${platformsQ}`).catch((e) => {
              console.warn('[growth] /api/analytics failed:', e?.message); return null
            })
          : null,
        uploadpost(`/api/uploadposts/total-impressions/${encodeURIComponent(username)}?period=last_month`).catch((e) => {
            console.warn('[growth] total-impressions last_month failed:', e?.message); return null
          }),
        uploadpost(`/api/uploadposts/total-impressions/${encodeURIComponent(username)}?period=last_3months`).catch((e) => {
            console.warn('[growth] total-impressions last_3months failed:', e?.message); return null
          }),
      ])

      if (accountStats && typeof accountStats === 'object') uploadpostStats = accountStats

      const totalLastMonth = Number(imprLastMonth?.total_impressions) || 0
      const totalLast3     = Number(imprLast3?.total_impressions) || 0
      thisImpressions = totalLastMonth
      // last_3months covers 90d; subtract last 30d to approximate
      // "30-60d ago" (i.e. previous month). Clamp at 0 if their data
      // is non-monotonic.
      lastImpressions = Math.max(0, totalLast3 - totalLastMonth)
      perPlatformImpr = imprLastMonth?.per_platform || null
    } catch (e) {
      console.warn('[growth] Upload-Post block failed:', e?.message)
    }

    // 3. Per-platform tiles — connected list × stats × delta against
    //    post counts (the only field we have monthly-resolved).
    const perPlatform = {}
    const allPlatforms = new Set([
      ...connectedPlatforms,
      ...Object.keys(thisMonthPosts.by_platform),
      ...Object.keys(lastMonthPosts.by_platform),
    ])
    for (const plat of allPlatforms) {
      const tmPosts = thisMonthPosts.by_platform[plat] || 0
      const lmPosts = lastMonthPosts.by_platform[plat] || 0
      const platStats = uploadpostStats?.[plat] || uploadpostStats?.platforms?.[plat] || null
      // Followers may sit under .followers, .followers_count, or
      // .stats.followers depending on the platform's response shape.
      const followers =
        platStats?.followers ??
        platStats?.followers_count ??
        platStats?.stats?.followers ??
        platStats?.account_info?.followers ??
        null
      perPlatform[plat] = {
        connected: connectedPlatforms.includes(plat),
        this_month: { posts: tmPosts },
        last_month: { posts: lmPosts },
        delta: { posts: delta(tmPosts, lmPosts) },
        followers: followers != null ? Number(followers) : null,
        impressions: perPlatformImpr?.[plat] != null ? Number(perPlatformImpr[plat]) : null,
      }
    }

    const summary = {
      this_month: {
        label: tm.label,
        posts: thisMonthPosts.total,
        impressions: thisImpressions,
      },
      last_month: {
        label: lm.label,
        posts: lastMonthPosts.total,
        impressions: lastImpressions,
      },
      deltas: {
        posts:       delta(thisMonthPosts.total, lastMonthPosts.total),
        impressions: thisImpressions != null && lastImpressions != null
          ? delta(thisImpressions, lastImpressions)
          : null,
      },
      per_platform: perPlatform,
      connected: connectedPlatforms,
      generated_at: new Date().toISOString(),
    }

    // Cache write. Same upsert pattern /api/analytics uses.
    try {
      const today = new Date().toISOString().slice(0, 10)
      const existing = await supaFetch(
        `analytics_snapshots?profile_id=eq.${profileId}&period=eq.mom&snapshot_date=eq.${today}&select=id`
      )
      const row = {
        profile_id: profileId,
        snapshot_date: today,
        period: 'mom',
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
      console.warn('[growth] cache upsert failed:', e.message)
    }

    return res.status(200).json({ ...summary, cached: false })
  } catch (err) {
    console.error('social/growth error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
