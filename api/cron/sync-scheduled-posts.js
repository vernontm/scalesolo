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
// Classify Upload-Post's status response into our row status.
//
// Upload-Post's actual response shape (confirmed live via debug probe):
//   {
//     status: "completed" | "in_progress" | "failed",
//     completed: <int>,
//     total: <int>,
//     results: [
//       { platform, success: true|false, post_url, error_message, ... },
//       ...
//     ],
//   }
//
// 'posted' when ANY platform succeeded; 'failed' when EVERY platform
// failed; null (leave scheduled) when still in progress.
//
// Returns { verdict, summary } where summary is a short human string
// describing per-platform outcomes so we can persist it as last_error
// on failure. Without this, failed rows had `last_error = null` and
// users couldn't see why the post died.
function classify(body) {
  if (!body || typeof body !== 'object') return { verdict: null, summary: null }

  // Per-platform results array — the canonical shape today.
  const resultsArr = Array.isArray(body.results)
    ? body.results
    : Array.isArray(body.data?.results)
      ? body.data.results
      : null
  if (Array.isArray(resultsArr) && resultsArr.length) {
    const anySuccess = resultsArr.some((r) => r?.success === true || r?.success === 'true')
    const allFailed  = resultsArr.every((r) => r?.success === false || r?.success === 'false')
    // Build a "tiktok: <reason> · instagram: <reason>" string so it
    // shows up on the row's last_error when we mark it failed.
    const summary = resultsArr
      .map((r) => {
        const p = (r?.platform || r?.network || 'unknown').toLowerCase()
        if (r?.success === true || r?.success === 'true') return `${p}: ok`
        const why = (r?.error_message || r?.error || r?.message || r?.reason || 'failed')
          .toString().trim().slice(0, 160)
        return `${p}: ${why}`
      })
      .join(' · ')
      .slice(0, 800)
    if (anySuccess) return { verdict: 'posted', summary: null }
    if (allFailed)  return { verdict: 'failed', summary }
    return { verdict: null, summary: null }  // partial / still progressing
  }

  // Legacy object-shaped variant: { platforms: { tiktok: 'posted', ... } }
  const platforms = body.platforms || body.data?.platforms || null
  if (platforms && typeof platforms === 'object' && !Array.isArray(platforms)) {
    const entries = Object.entries(platforms)
    const states = entries.map(([, v]) => {
      if (typeof v === 'string') return v.toLowerCase()
      if (v?.status) return String(v.status).toLowerCase()
      if (v?.state)  return String(v.state).toLowerCase()
      if (v?.success === true)  return 'success'
      if (v?.success === false) return 'failed'
      return ''
    })
    const summary = entries.map(([k, v], i) => {
      const s = states[i]
      if (/post|deliver|success/.test(s)) return `${k}: ok`
      const why = (v?.error_message || v?.error || v?.message || s || 'failed')
        .toString().trim().slice(0, 160)
      return `${k}: ${why}`
    }).join(' · ').slice(0, 800)
    if (states.some((s) => /post|deliver|success/.test(s))) return { verdict: 'posted', summary: null }
    if (states.length && states.every((s) => /fail|error/.test(s))) return { verdict: 'failed', summary }
    return { verdict: null, summary: null }
  }

  // Last-ditch: top-level only. Recognize "completed" since that's
  // what the documented endpoint returns when all platforms have fired.
  const topStatus = String(body.status || body.state || '').toLowerCase()
  if (topStatus === 'completed' || topStatus === 'posted' || topStatus === 'delivered') return { verdict: 'posted', summary: null }
  if (topStatus === 'failed' || topStatus === 'error') {
    const why = (body.error_message || body.error || body.message || topStatus).toString().slice(0, 800)
    return { verdict: 'failed', summary: why }
  }
  return { verdict: null, summary: null }
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
    // Primary pass: scheduled rows past their fire time. Plus a
    // secondary pass picking up rows already marked `failed` but
    // with no last_error captured — back-fills per-platform error
    // reasons on legacy failures so Ray (and end users) can see
    // why a post died instead of staring at an empty error column.
    const dueScheduled = await supaFetch(
      `content_scripts?status=eq.scheduled&scheduled_datetime=lt.${encodeURIComponent(nowIso)}` +
      `&uploadpost_request_id=not.is.null&select=id,status,uploadpost_request_id,scheduled_datetime&limit=200`
    ).catch(() => [])
    const orphanedFails = await supaFetch(
      `content_scripts?status=eq.failed&last_error=is.null` +
      `&uploadpost_request_id=not.is.null&select=id,status,uploadpost_request_id,scheduled_datetime&limit=50`
    ).catch(() => [])
    const rows = [...(dueScheduled || []), ...(orphanedFails || [])]

    const results = { posted: 0, failed: 0, indeterminate: 0, errors: 0, backfilled: 0 }

    for (const row of rows) {
      try {
        const { ok, status, body } = await fetchStatus(row.uploadpost_request_id)

        // Existing-failed back-fill. Two scenarios:
        //
        //   (a) Row was wrongly marked failed because the cron ran
        //       within seconds of scheduled_datetime — before
        //       Upload-Post had finished pushing to any platform.
        //       classify() saw [tiktok: pending, ig: pending, ...]
        //       interpreted them as `success: false` and flipped
        //       status to failed. By the time the back-fill runs
        //       (minutes-to-hours later) TikTok / IG / etc may
        //       have actually delivered, so the row should be
        //       PROMOTED BACK to status='posted'. This is what bit
        //       Ava's post: TikTok delivered, but our row says
        //       failed because we polled too early.
        //
        //   (b) Genuinely failed everywhere. classify() returns
        //       verdict='failed' (or null if Upload-Post purged
        //       the detail). In that case we just write
        //       diagnostic info to last_error so the user can see
        //       what Upload-Post said and the row stays failed.
        if (row.status === 'failed') {
          const { verdict, summary } = classify(body)
          // Compact preview of the raw response in case we need to
          // read it later — capped so we don't dump a 5KB blob.
          const rawPreview = (() => {
            try {
              if (!body) return 'empty body'
              const j = typeof body === 'string' ? body : JSON.stringify(body)
              return j.length > 240 ? j.slice(0, 240) + '…' : j
            } catch { return '<unserializable>' }
          })()

          // Scenario (a): Upload-Post now shows at least one
          // platform succeeded. Flip status back to posted +
          // clear the (incorrect) last_error.
          if (ok && verdict === 'posted') {
            await supaFetch(`content_scripts?id=eq.${row.id}`, {
              method: 'PATCH',
              body: { status: 'posted', last_error: null },
              prefer: 'return=minimal',
            })
            results.posted += 1
            continue
          }

          // Scenario (b): still failed. Write whatever diagnostic
          // info we can scrape together.
          const errorText = summary
            || (!ok ? `Upload-Post status endpoint returned HTTP ${status}: ${rawPreview}` : null)
            || (body?.status ? `Upload-Post status: ${body.status} · raw: ${rawPreview}` : null)
            || `Upload-Post returned no per-platform error detail. raw: ${rawPreview}`
          await supaFetch(`content_scripts?id=eq.${row.id}`, {
            method: 'PATCH',
            body: { last_error: errorText.slice(0, 1000) },
            prefer: 'return=minimal',
          })
          results.backfilled += 1
          continue
        }

        if (!ok) { results.errors += 1; continue }
        const { verdict, summary } = classify(body)

        if (verdict === 'posted') {
          await supaFetch(`content_scripts?id=eq.${row.id}`, {
            method: 'PATCH',
            body: { status: 'posted', last_error: null },
            prefer: 'return=minimal',
          })
          results.posted += 1
        } else if (verdict === 'failed') {
          // Grace window. Upload-Post takes minutes to actually
          // push to TikTok/IG/YouTube/Facebook after we submit. If
          // the cron polls within ~5 min of scheduled_datetime and
          // every platform reports `success: false`, that's almost
          // never a real failure — it's "Upload-Post hasn't
          // delivered yet, give it more time." Leaving the row as
          // scheduled means the next cron tick (10 min later) will
          // re-check and we'll see the real outcome. This is the
          // bug that bit Ava's post: cron fired 44 seconds after
          // scheduled_datetime, all platforms still pending, we
          // marked it failed, but TikTok actually delivered
          // minutes later.
          const scheduledMs = Date.parse(row.scheduled_datetime || '')
          const ageMs       = Number.isFinite(scheduledMs) ? Date.now() - scheduledMs : Infinity
          const GRACE_MS    = 5 * 60 * 1000
          if (ageMs < GRACE_MS) {
            results.indeterminate += 1
            continue
          }
          await supaFetch(`content_scripts?id=eq.${row.id}`, {
            method: 'PATCH',
            body: {
              status: 'failed',
              last_error: summary || 'All platforms reported failure (no detail returned).',
            },
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
      examined: rows.length,
      ...results,
    })
  } catch (err) {
    console.error('sync-scheduled-posts error:', err?.stack || err)
    return res.status(500).json({ error: err.message })
  }
}
