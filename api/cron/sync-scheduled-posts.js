// Cron: sync content_scripts rows that were scheduled in Upload-Post
// past their scheduled_datetime. Upload-Post doesn't webhook us when
// a scheduled post goes live, so without this cron our row stays at
// status='scheduled' forever even after delivery.
//
// Walks every row where:
//   * status = 'scheduled'
//   * scheduled_datetime < now() (i.e. should have fired)
//   * uploadpost_request_id IS NOT NULL (we have a handle to look up)
// and calls Upload-Post's status endpoint. Flips our row to:
//   * 'posted' if Upload-Post reports delivered to >= 1 platform
//   * 'failed' if Upload-Post reports all platforms failed
// (mixed = leave as scheduled and try again next cron tick.)
//
// Schedule: every 10 minutes via vercel.json crons.
// Auth: CRON_SECRET bearer.

import { setCors, supaFetch } from '../_lib/supabase.js'

const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY

async function fetchStatus(requestId) {
  const r = await fetch(
    `https://api.upload-post.com/api/uploadposts/status?request_id=${encodeURIComponent(requestId)}`,
    { headers: { Authorization: `Apikey ${UPLOADPOST_API_KEY}` } }
  )
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  return { ok: r.ok, status: r.status, body }
}

// Look at Upload-Post's per-platform delivery state. Their response
// shape varies but typically has either `platforms: { tiktok: 'posted'|'failed', … }`
// or top-level success/error markers. We're conservative: only flip to
// 'posted' when at least one platform clearly succeeded; only 'failed'
// when every platform clearly failed.
function classify(body) {
  if (!body || typeof body !== 'object') return null
  const platforms = body.platforms || body.results || body.data?.platforms || null
  if (!platforms || typeof platforms !== 'object') {
    // Fallback heuristics on top-level fields.
    if (body.status === 'posted' || body.state === 'posted') return 'posted'
    if (body.status === 'failed' || body.state === 'failed') return 'failed'
    return null
  }
  const states = Object.values(platforms).map((v) => {
    if (typeof v === 'string') return v.toLowerCase()
    if (v?.status) return String(v.status).toLowerCase()
    if (v?.state) return String(v.state).toLowerCase()
    return ''
  })
  if (!states.length) return null
  const anyPosted = states.some((s) => /post|deliver|success/.test(s))
  const allFailed = states.every((s) => /fail|error/.test(s))
  if (anyPosted) return 'posted'
  if (allFailed) return 'failed'
  return null
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || !bearer || bearer !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (!UPLOADPOST_API_KEY) {
    return res.status(500).json({ error: 'UPLOADPOST_API_KEY not configured' })
  }

  try {
    const nowIso = new Date().toISOString()
    const rows = await supaFetch(
      `content_scripts?status=eq.scheduled&scheduled_datetime=lt.${encodeURIComponent(nowIso)}` +
      `&uploadpost_request_id=not.is.null&select=id,uploadpost_request_id,scheduled_datetime,profile_id&limit=200`
    ).catch(() => [])

    const results = { posted: 0, failed: 0, indeterminate: 0, errors: 0 }

    for (const row of rows || []) {
      try {
        const { ok, body } = await fetchStatus(row.uploadpost_request_id)
        if (!ok) { results.errors += 1; continue }
        const verdict = classify(body)
        if (verdict === 'posted') {
          await supaFetch(`content_scripts?id=eq.${row.id}`, {
            method: 'PATCH',
            body: { status: 'posted' },
            prefer: 'return=minimal',
          })
          results.posted += 1
        } else if (verdict === 'failed') {
          await supaFetch(`content_scripts?id=eq.${row.id}`, {
            method: 'PATCH',
            body: { status: 'failed' },
            prefer: 'return=minimal',
          })
          results.failed += 1
        } else {
          results.indeterminate += 1
        }
      } catch (e) {
        console.warn('sync-scheduled-posts row failed:', row.id, e?.message)
        results.errors += 1
      }
    }

    return res.status(200).json({
      examined: (rows || []).length,
      ...results,
    })
  } catch (err) {
    console.error('sync-scheduled-posts error:', err?.stack || err)
    return res.status(500).json({ error: err.message })
  }
}
