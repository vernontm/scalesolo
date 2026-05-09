// PUBLIC analytics beacon. POST { page_id, scroll_depth_pct?, time_on_page_sec?, utm? }
//
// Defense in depth, since this endpoint is unauthenticated:
//   1. UUID-validate page_id (PostgREST otherwise 400s on garbage but
//      we shouldn't even open the connection for it).
//   2. Confirm the landing_pages row exists + is_published before
//      inserting a view. Stops attackers from filling the table with
//      views for arbitrary / non-existent ids.
//   3. Per-IP token bucket (in-memory, best-effort) caps a single IP
//      to ~30 events / minute. Cold-starts reset the bucket which is
//      fine — it stops scripted floods, not determined attackers.
//   4. Cap string fields server-side (utm, referrer, user_agent).

import { setCors, supaFetch } from '../_lib/supabase.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RATE_LIMIT_MAX = 30
const RATE_LIMIT_WINDOW_MS = 60_000
const _ipBucket = new Map()  // ip → { count, resetAt }

function rateLimitOk(ip) {
  if (!ip) return true   // no IP header in dev
  const now = Date.now()
  const cur = _ipBucket.get(ip)
  if (!cur || cur.resetAt < now) {
    _ipBucket.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    if (_ipBucket.size > 5000) {
      // Garbage-collect expired entries when the bucket gets huge.
      for (const [k, v] of _ipBucket) if (v.resetAt < now) _ipBucket.delete(k)
    }
    return true
  }
  cur.count += 1
  return cur.count <= RATE_LIMIT_MAX
}

function clamp(v, max) {
  if (v == null) return null
  return String(v).slice(0, max)
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).end()

  try {
    const { page_id, scroll_depth_pct, time_on_page_sec, utm } = req.body || {}
    if (!page_id || !UUID_RE.test(String(page_id))) {
      return res.status(400).json({ error: 'page_id required (uuid)' })
    }

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null
    if (!rateLimitOk(ip)) {
      return res.status(429).json({ error: 'Too many requests' })
    }

    // Verify the page exists + is published. PostgREST `is_published=eq.true`
    // filters out drafts. This lookup is itself rate-limited per IP via the
    // bucket above, so a flood can't DoS the DB.
    const pages = await supaFetch(
      `landing_pages?id=eq.${page_id}&is_published=eq.true&select=id&limit=1`
    ).catch(() => [])
    if (!pages?.length) {
      // Don't leak which pages exist. 200 + no insert.
      return res.status(200).json({ ok: true })
    }

    const referrer = clamp(req.headers.referer, 1024)
    const ua = clamp(req.headers['user-agent'], 512)
    // Whitelist UTM keys + clamp values so a hostile beacon can't
    // dump arbitrary jsonb.
    let cleanUtm = null
    if (utm && typeof utm === 'object') {
      cleanUtm = {}
      for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
        if (utm[k] != null) cleanUtm[k] = clamp(utm[k], 200)
      }
    }

    // Numeric coercion + clamp.
    const scroll = scroll_depth_pct == null ? null : Math.max(0, Math.min(100, Math.round(Number(scroll_depth_pct) || 0)))
    const tos    = time_on_page_sec == null ? null : Math.max(0, Math.min(86400, Math.round(Number(time_on_page_sec) || 0)))

    await supaFetch('landing_page_views', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        page_id,
        scroll_depth_pct: scroll,
        time_on_page_sec: tos,
        utm: cleanUtm,
        referrer,
        user_agent: ua,
        ip_address: ip,
      },
    })
    return res.status(200).json({ ok: true })
  } catch (err) {
    // Public beacon; never error to the visitor.
    console.warn('landing/track:', err?.message || err)
    return res.status(200).json({ ok: true })
  }
}
