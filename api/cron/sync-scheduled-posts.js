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

// ── Auto-retry ─────────────────────────────────────────────────────────
// Upload-Post's POST /api/uploadposts/retry (documented in llm.txt)
// retries ONLY the platforms that failed on the original request and
// reuses the original media snapshot — no re-upload, no double-posting
// on platforms that already delivered. 409 = "nothing to retry", i.e.
// every platform actually succeeded.
//
// Backoff ladder: quick first retries for transient blips, long tail
// for TikTok's daily active-user cap (resets 24h after it's hit).
const MAX_PUBLISH_RETRIES = 6
const RETRY_BACKOFF_MS = [
  10 * 60 * 1000,        // 10 min
  30 * 60 * 1000,        // 30 min
  60 * 60 * 1000,        // 1 h
  3 * 60 * 60 * 1000,    // 3 h
  8 * 60 * 60 * 1000,    // 8 h
  24 * 60 * 60 * 1000,   // 24 h
]
const nextRetryIso = (retryCount) => new Date(
  Date.now() + (RETRY_BACKOFF_MS[Math.min(retryCount, RETRY_BACKOFF_MS.length - 1)])
).toISOString()

async function requestRetry(requestId) {
  const r = await fetch('https://api.upload-post.com/api/uploadposts/retry', {
    method: 'POST',
    headers: { Authorization: `Apikey ${UPLOADPOST_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestId }),
  })
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  // 409 = no failed platforms — treat as "all delivered".
  return { ok: r.ok, status: r.status, nothingToRetry: r.status === 409, body }
}

// ── TikTok forced Direct Post ──────────────────────────────────────────
// Upload-Post's shared daily active-user cap makes TikTok fall back to
// MEDIA_UPLOAD (Inbox, tap-to-publish) with success=true — so their
// retry endpoint refuses to touch it (nothing "failed"). For profiles
// that opted in via tiktok_force_direct_post, we re-submit the video as
// a fresh TIKTOK-ONLY post on a long backoff until one attempt lands on
// the feed. IG/FB/etc from the original request are never re-sent.
// Trade-off the profile owner accepted: every attempt that hits a
// still-capped window stacks one more unposted draft in the TikTok
// inbox (ignore those; tapping one after a feed success = duplicate).
const MAX_TIKTOK_INBOX_RETRIES = 5
const TIKTOK_INBOX_BACKOFF_MS = [
  2 * 60 * 60 * 1000,    // 2 h
  4 * 60 * 60 * 1000,    // 4 h
  8 * 60 * 60 * 1000,    // 8 h
  12 * 60 * 60 * 1000,   // 12 h
  24 * 60 * 60 * 1000,   // 24 h
]
const nextInboxRetryIso = (count) => new Date(
  Date.now() + (TIKTOK_INBOX_BACKOFF_MS[Math.min(count, TIKTOK_INBOX_BACKOFF_MS.length - 1)])
).toISOString()

// True when the tiktok result "succeeded" into the Inbox instead of
// the feed. A real feed delivery has an http(s) post_url.
function tiktokInboxResult(resultsArr) {
  if (!Array.isArray(resultsArr)) return null
  const tk = resultsArr.find((r) => String(r?.platform || '').toLowerCase() === 'tiktok')
  if (!tk) return null
  const url = String(tk.post_url || '')
  const delivered = tk.success === true || tk.success === 'true'
  if (delivered && /inbox/i.test(url)) return { state: 'inbox' }
  if (delivered && /^https?:\/\//.test(url)) return { state: 'feed', url }
  if (tk.success === false || tk.success === 'false') return { state: 'failed' }
  return { state: 'pending' }
}

// Fresh TikTok-only submission reusing the row's media + copy. Video
// rows only — that's what TikTok takes from us in practice.
async function resubmitTikTokOnly(row, uploadpostUser) {
  const videoUrl = (row.embed_cover_intro !== false && row.media_url_with_cover)
    ? row.media_url_with_cover
    : (Array.isArray(row.media_urls) ? row.media_urls[0] : null)
  if (!videoUrl || !/^https?:\/\//.test(videoUrl)) return { ok: false, reason: 'no_video_url' }
  const fullCaption = [row.caption, row.hashtags].filter(Boolean).join('\n\n').trim()
  const fd = new FormData()
  fd.append('user', uploadpostUser)
  fd.append('platform[]', 'tiktok')
  fd.append('video', videoUrl)
  fd.append('async_upload', 'true')
  // TikTok's on-video caption comes from tiktok_title (it ignores
  // `description`) — send the full caption+hashtags there, matching
  // the normal publish path in bulk-actions.js.
  const tkCaption = fullCaption || (row.title ? String(row.title).trim() : '')
  if (tkCaption) fd.append('tiktok_title', tkCaption.slice(0, 2200))
  if (fullCaption) fd.append('description', fullCaption.slice(0, 2200))
  const r = await fetch('https://api.upload-post.com/api/upload', {
    method: 'POST',
    headers: { Authorization: `Apikey ${UPLOADPOST_API_KEY}` },
    body: fd,
  })
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  return { ok: r.ok, status: r.status, requestId: body?.request_id || null, body }
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
//
// Edge case Upload-Post hits us with: status='in_progress' with
// completed > 0 but total has never settled. In practice this means
// SOME platforms delivered (those in the results array) and others
// never will (no token, no platform setup, Upload-Post stuck). We
// treat partial completion as 'posted' once at least one result
// shows success — there's no value to waiting forever for the
// remaining platforms that are never coming.
function classify(body) {
  if (!body || typeof body !== 'object') return { verdict: null, summary: null }

  // Per-platform results array — the canonical shape today.
  const resultsArr = Array.isArray(body.results)
    ? body.results
    : Array.isArray(body.data?.results)
      ? body.data.results
      : null
  if (Array.isArray(resultsArr) && resultsArr.length) {
    // Treat any truthy value as success — Upload-Post has at various
    // times returned `success: true`, `"true"`, `"success"`, or an
    // `upload_timestamp` field alongside no success flag at all.
    // The presence of an upload_timestamp is the strongest signal
    // that the platform actually delivered.
    const isResultSuccess = (r) => {
      if (r?.success === true || r?.success === 'true') return true
      if (typeof r?.status === 'string' && /post|deliver|success|complet/i.test(r.status)) return true
      if (r?.upload_timestamp || r?.post_url) return true
      return false
    }
    const anySuccess = resultsArr.some(isResultSuccess)
    const allFailed  = resultsArr.every((r) => r?.success === false || r?.success === 'false')
    // Platforms that hard-failed — feeds the auto-retry machinery so a
    // partially-delivered post (e.g. FB+Threads ok, TikTok hit its
    // daily cap) still gets its stragglers retried.
    const failedPlatforms = resultsArr
      .filter((r) => (r?.success === false || r?.success === 'false') && !isResultSuccess(r))
      .map((r) => (r?.platform || r?.network || 'unknown').toLowerCase())
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
    if (anySuccess) return { verdict: 'posted', summary: null, failedPlatforms }
    if (allFailed)  return { verdict: 'failed', summary, failedPlatforms }
    return { verdict: null, summary: null, failedPlatforms: [] }  // partial / still progressing
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
    const RETRY_COLS = 'id,profile_id,status,uploadpost_request_id,scheduled_datetime,publish_retry_count,publish_next_retry_at,tiktok_retry_request_id,media_type,media_urls,media_url_with_cover,embed_cover_intro,title,caption,hashtags'

    // Per-profile tiktok_force_direct_post flag + upload-post username,
    // cached per cron run so N rows on the same brand cost one lookup.
    const profileCache = new Map()
    const getProfileMeta = async (profileId) => {
      if (!profileId) return { force: false, username: null }
      if (profileCache.has(profileId)) return profileCache.get(profileId)
      let meta = { force: false, username: null }
      try {
        const rows2 = await supaFetch(`profiles?id=eq.${profileId}&select=tiktok_force_direct_post,uploadpost_user`)
        const p = rows2?.[0]
        if (p) {
          const { deriveUploadPostUsername } = await import('../_lib/uploadpost.js')
          meta = {
            force: !!p.tiktok_force_direct_post,
            username: (p.uploadpost_user && p.uploadpost_user.trim()) || deriveUploadPostUsername(profileId),
          }
        }
      } catch { /* default meta */ }
      profileCache.set(profileId, meta)
      return meta
    }
    const dueScheduled = await supaFetch(
      `content_scripts?status=eq.scheduled&scheduled_datetime=lt.${encodeURIComponent(nowIso)}` +
      `&uploadpost_request_id=not.is.null&select=${RETRY_COLS}&limit=200`
    ).catch(() => [])
    const orphanedFails = await supaFetch(
      `content_scripts?status=eq.failed&last_error=is.null` +
      `&uploadpost_request_id=not.is.null&select=${RETRY_COLS}&limit=50`
    ).catch(() => [])
    const rows = [...(dueScheduled || []), ...(orphanedFails || [])]

    const results = { posted: 0, failed: 0, indeterminate: 0, errors: 0, backfilled: 0, ghosts: 0, retried: 0, retry_exhausted: 0 }

    // Partial-failure retry sweep. Rows that flipped to 'posted' with
    // some platform still failed (e.g. TikTok daily cap while FB and
    // Threads delivered) carry a publish_next_retry_at. When it comes
    // due, re-check Upload-Post and retry the stragglers. Scheduled
    // rows are excluded — the main pass below owns those.
    const dueRetries = await supaFetch(
      `content_scripts?status=eq.posted&publish_next_retry_at=lte.${encodeURIComponent(nowIso)}` +
      `&uploadpost_request_id=not.is.null&tiktok_retry_request_id=is.null&select=${RETRY_COLS}&limit=50`
    ).catch(() => [])
    for (const row of (dueRetries || [])) {
      try {
        const { ok, body } = await fetchStatus(row.uploadpost_request_id)
        const { failedPlatforms } = ok ? classify(body) : { failedPlatforms: [] }
        const count = row.publish_retry_count || 0
        if (!ok || !failedPlatforms.length) {
          // Everything delivered (or status is unreadable — stop churning).
          await supaFetch(`content_scripts?id=eq.${row.id}`, {
            method: 'PATCH', body: { publish_next_retry_at: null }, prefer: 'return=minimal',
          })
          continue
        }
        if (count >= MAX_PUBLISH_RETRIES) {
          await supaFetch(`content_scripts?id=eq.${row.id}`, {
            method: 'PATCH',
            body: {
              publish_next_retry_at: null,
              last_error: `Auto-retry gave up after ${count} attempts; still failed: ${failedPlatforms.join(', ')}`,
            },
            prefer: 'return=minimal',
          })
          results.retry_exhausted += 1
          continue
        }
        const retry = await requestRetry(row.uploadpost_request_id)
        await supaFetch(`content_scripts?id=eq.${row.id}`, {
          method: 'PATCH',
          body: retry.nothingToRetry
            ? { publish_next_retry_at: null }
            : {
                publish_retry_count: count + 1,
                publish_next_retry_at: nextRetryIso(count + 1),
                last_error: `Auto-retry ${count + 1}/${MAX_PUBLISH_RETRIES} sent for: ${failedPlatforms.join(', ')}`,
              },
          prefer: 'return=minimal',
        })
        if (!retry.nothingToRetry) results.retried += 1
      } catch (e) {
        console.warn('retry sweep row failed:', row.id, e?.message)
        results.errors += 1
      }
    }

    // TikTok forced-Direct-Post chain sweep. Rows with an active
    // re-submission chain (tiktok_retry_request_id set) get their
    // LATEST tiktok-only request polled when the backoff comes due:
    //   feed URL  → done, clear the chain, note the win
    //   inbox/failed again → re-submit if budget remains, else give up
    const dueInboxChains = await supaFetch(
      `content_scripts?tiktok_retry_request_id=not.is.null` +
      `&publish_next_retry_at=lte.${encodeURIComponent(nowIso)}&select=${RETRY_COLS}&limit=50`
    ).catch(() => [])
    for (const row of (dueInboxChains || [])) {
      try {
        const { ok, body } = await fetchStatus(row.tiktok_retry_request_id)
        const tk = ok ? tiktokInboxResult(body?.results) : null
        const count = row.publish_retry_count || 0
        if (tk?.state === 'feed') {
          await supaFetch(`content_scripts?id=eq.${row.id}`, {
            method: 'PATCH',
            body: {
              tiktok_retry_request_id: null,
              publish_next_retry_at: null,
              last_error: `TikTok direct-posted on retry ${count}: ${tk.url}`,
            },
            prefer: 'return=minimal',
          })
          results.tiktok_feed_landed = (results.tiktok_feed_landed || 0) + 1
          continue
        }
        if (tk?.state === 'pending') { continue }  // still uploading — next tick
        if (count >= MAX_TIKTOK_INBOX_RETRIES) {
          await supaFetch(`content_scripts?id=eq.${row.id}`, {
            method: 'PATCH',
            body: {
              tiktok_retry_request_id: null,
              publish_next_retry_at: null,
              last_error: `TikTok forced-direct-post gave up after ${count} attempts (cap never freed). Latest copy is in the TikTok inbox — tap-publish or let it sit.`,
            },
            prefer: 'return=minimal',
          })
          results.retry_exhausted += 1
          continue
        }
        const meta = await getProfileMeta(row.profile_id)
        const resub = meta.username ? await resubmitTikTokOnly(row, meta.username) : { ok: false, reason: 'no_username' }
        await supaFetch(`content_scripts?id=eq.${row.id}`, {
          method: 'PATCH',
          body: resub.ok && resub.requestId
            ? {
                tiktok_retry_request_id: resub.requestId,
                publish_retry_count: count + 1,
                publish_next_retry_at: nextInboxRetryIso(count + 1),
                last_error: `TikTok direct-post retry ${count + 1}/${MAX_TIKTOK_INBOX_RETRIES} submitted (previous attempt hit the cap → inbox).`,
              }
            : {
                // Submission itself failed — keep the chain, try again next backoff.
                publish_next_retry_at: nextInboxRetryIso(count + 1),
                last_error: `TikTok direct-post retry submission errored (${resub.reason || resub.status}); will try again.`,
              },
          prefer: 'return=minimal',
        })
        if (resub.ok) results.tiktok_resubmitted = (results.tiktok_resubmitted || 0) + 1
      } catch (e) {
        console.warn('tiktok inbox chain row failed:', row.id, e?.message)
        results.errors += 1
      }
    }

    // Ghost sweep. A row marked `scheduled` and already past its fire
    // time but carrying NO uploadpost_request_id was never actually
    // queued at Upload-Post (e.g. a crash between the status flip and
    // the request_id PATCH, or a legacy auto-schedule path that flipped
    // status without submitting). The primary pass above can't see these
    // — it filters uploadpost_request_id IS NOT NULL — so without this
    // sweep they sit as scheduled forever and never publish. Flip them to
    // failed with a clear reason so they surface in the UI instead of
    // silently vanishing. Legit scheduled posts are always future-dated,
    // so a past-due null-handle row is unambiguously stuck.
    const ghosts = await supaFetch(
      `content_scripts?status=eq.scheduled&scheduled_datetime=lt.${encodeURIComponent(nowIso)}` +
      `&uploadpost_request_id=is.null&select=id,scheduled_datetime&limit=200`
    ).catch(() => [])
    for (const g of (ghosts || [])) {
      await supaFetch(`content_scripts?id=eq.${g.id}`, {
        method: 'PATCH',
        body: {
          status: 'failed',
          last_error: 'Never submitted to Upload-Post (no request_id) and the scheduled time has passed. Re-publish or re-schedule this post.',
          last_error_at: nowIso,
        },
        prefer: 'return=minimal',
      }).then(() => { results.ghosts += 1 }).catch(() => {})
    }

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
          // Preview of the raw response for diagnostic purposes.
          // Capped at ~800 chars so we can see the whole results
          // array on a typical 4-platform post without exhausting
          // the 1000-char last_error budget.
          const rawPreview = (() => {
            try {
              if (!body) return 'empty body'
              const j = typeof body === 'string' ? body : JSON.stringify(body)
              return j.length > 800 ? j.slice(0, 800) + '…' : j
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
            body: { last_error: errorText.slice(0, 2000) },
            prefer: 'return=minimal',
          })
          results.backfilled += 1
          continue
        }

        if (!ok) { results.errors += 1; continue }
        const { verdict, summary, failedPlatforms = [] } = classify(body)
        const retryCount = row.publish_retry_count || 0

        if (verdict === 'posted') {
          // Partially delivered? Fire the first retry for the failed
          // platforms right away and arm the backoff sweep above for
          // follow-ups. Upload-Post's retry endpoint only touches the
          // platforms that failed, so the delivered ones are safe.
          const patch = { status: 'posted', last_error: null }
          if (failedPlatforms.length && retryCount < MAX_PUBLISH_RETRIES) {
            const retry = await requestRetry(row.uploadpost_request_id).catch(() => null)
            if (retry && !retry.nothingToRetry) {
              patch.publish_retry_count = retryCount + 1
              patch.publish_next_retry_at = nextRetryIso(retryCount + 1)
              patch.last_error = `Posted, but auto-retry ${retryCount + 1}/${MAX_PUBLISH_RETRIES} sent for: ${failedPlatforms.join(', ')}`
              results.retried += 1
            }
          }
          // TikTok landed in the Inbox instead of the feed? For opted-in
          // profiles, start the forced-direct-post chain: submit a fresh
          // tiktok-only copy now; the chain sweep above polls the outcome
          // and re-submits on backoff until one attempt beats the cap.
          const tk = tiktokInboxResult(body?.results || body?.data?.results)
          if (tk?.state === 'inbox' && !row.tiktok_retry_request_id && row.media_type === 'video' && retryCount < MAX_TIKTOK_INBOX_RETRIES) {
            const meta = await getProfileMeta(row.profile_id)
            if (meta.force && meta.username) {
              const resub = await resubmitTikTokOnly(row, meta.username).catch(() => null)
              if (resub?.ok && resub.requestId) {
                patch.tiktok_retry_request_id = resub.requestId
                patch.publish_retry_count = retryCount + 1
                patch.publish_next_retry_at = nextInboxRetryIso(retryCount + 1)
                patch.last_error = `TikTok went to Inbox (cap). Direct-post retry 1/${MAX_TIKTOK_INBOX_RETRIES} submitted — do NOT tap-publish the inbox copies.`
                results.tiktok_resubmitted = (results.tiktok_resubmitted || 0) + 1
              }
            }
          }
          await supaFetch(`content_scripts?id=eq.${row.id}`, {
            method: 'PATCH',
            body: patch,
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

          // Auto-retry before declaring death. A full failure is often
          // transient (platform rate limits, TikTok's daily active-user
          // cap, Upload-Post worker hiccups). Call their retry endpoint
          // — original media is reused server-side — and keep the row
          // as 'scheduled' so this sweep re-checks the outcome. Backoff
          // gates how often we fire; MAX_PUBLISH_RETRIES caps the total.
          const retryDueMs = row.publish_next_retry_at ? Date.parse(row.publish_next_retry_at) : 0
          if (retryCount < MAX_PUBLISH_RETRIES) {
            if (retryDueMs > Date.now()) {
              // Backoff not elapsed yet — leave as scheduled, check next tick.
              results.indeterminate += 1
              continue
            }
            const retry = await requestRetry(row.uploadpost_request_id).catch(() => null)
            if (retry?.nothingToRetry) {
              // Everything actually delivered between our status poll
              // and the retry call. Promote to posted.
              await supaFetch(`content_scripts?id=eq.${row.id}`, {
                method: 'PATCH',
                body: { status: 'posted', last_error: null, publish_next_retry_at: null },
                prefer: 'return=minimal',
              })
              results.posted += 1
              continue
            }
            if (retry?.ok) {
              await supaFetch(`content_scripts?id=eq.${row.id}`, {
                method: 'PATCH',
                body: {
                  publish_retry_count: retryCount + 1,
                  publish_next_retry_at: nextRetryIso(retryCount + 1),
                  last_error: `Auto-retry ${retryCount + 1}/${MAX_PUBLISH_RETRIES} sent (${summary || 'all platforms failed'})`,
                },
                prefer: 'return=minimal',
              })
              results.retried += 1
              continue
            }
            // Retry endpoint itself errored (404 = request purged, etc):
            // no path forward, fall through to the permanent failure.
          }
          await supaFetch(`content_scripts?id=eq.${row.id}`, {
            method: 'PATCH',
            body: {
              status: 'failed',
              publish_next_retry_at: null,
              last_error: (retryCount >= MAX_PUBLISH_RETRIES
                ? `Auto-retry gave up after ${retryCount} attempts. `
                : '') + (summary || 'All platforms reported failure (no detail returned).'),
            },
            prefer: 'return=minimal',
          })
          results.failed += 1
          if (retryCount >= MAX_PUBLISH_RETRIES) results.retry_exhausted += 1
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
