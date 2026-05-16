// POST /api/videos/prepend-cover
// Body: { script_id, duration_secs? }
//
// Submits a Fly worker job that builds a new MP4 = cover image as
// 1s intro card + source video. The result lands in Supabase Storage
// and the URL is persisted on the row at media_url_with_cover. At
// Upload-Post submission time, the bulk-actions / upload-post code
// picks media_url_with_cover for non-IG platforms when embed_cover_intro
// is true, so the cover surfaces as the start-frame thumbnail on
// TikTok / YouTube Shorts / FB Reels / Threads. Instagram keeps using
// the raw video + instagram_cover_url because IG handles covers natively.
//
// No AI tokens charged — this is pure ffmpeg work on the Fly worker.

import { setCors, requireUser, supaFetch, assertProfileAccess, fmtErr } from '../_lib/supabase.js'

export const config = { maxDuration: 300 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const body = req.body || {}
    if (!body.script_id) return res.status(400).json({ error: 'script_id required' })

    // Fetch the row up front. We need the source video URL + the cover
    // URL + profile id (for credit attribution and storage path).
    const rows = await supaFetch(
      `content_scripts?id=eq.${body.script_id}&select=id,profile_id,media_urls,media_type,cover_image_url`
    )
    const row = rows?.[0]
    if (!row) return res.status(404).json({ error: 'Content row not found' })
    await assertProfileAccess(auth.user.id, row.profile_id)

    if (row.media_type !== 'video') {
      return res.status(409).json({ error: 'Only video posts support cover-intro embedding.', code: 'not_a_video' })
    }
    const sourceUrl = Array.isArray(row.media_urls) && row.media_urls[0]
    if (!sourceUrl) return res.status(409).json({ error: 'Row has no source video URL.', code: 'no_source_video' })
    if (!row.cover_image_url) {
      return res.status(409).json({
        error: 'No cover image set on this post. Generate one first, then embed.',
        code: 'no_cover_image',
      })
    }

    const WORKER_URL = process.env.WORKER_URL
    const WORKER_SECRET = process.env.WORKER_SHARED_SECRET
    if (!WORKER_URL) return res.status(503).json({ error: 'WORKER_URL not configured' })

    const workerBase = WORKER_URL.replace(/\/$/, '')
    const headers = {
      'Content-Type': 'application/json',
      ...(WORKER_SECRET ? { 'x-worker-secret': WORKER_SECRET } : {}),
    }

    // Submit async — worker returns job_id immediately, processes in
    // background. We then long-poll up to 250s (leaving 50s headroom
    // under Vercel's 300s gateway timeout). Most cover-intro jobs
    // finish in 10-30s because they're just a brief re-encode.
    const submitRes = await fetch(`${workerBase}/jobs/prepend-cover-async`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        profile_id: row.profile_id,
        video_url: sourceUrl,
        cover_image_url: row.cover_image_url,
        duration_secs: typeof body.duration_secs === 'number' && body.duration_secs > 0
          ? Math.min(5, body.duration_secs)
          : 1.0,
      }),
    })
    const submitBody = await submitRes.json().catch(() => ({}))
    if (!submitRes.ok || !submitBody?.job_id) {
      return res.status(submitRes.status || 502).json({
        error: fmtErr(submitBody?.error) || `Worker submit ${submitRes.status}`,
      })
    }
    const jobId = submitBody.job_id

    // Long-poll. 4s interval, 250s deadline.
    const POLL_DEADLINE_MS = 250_000
    const POLL_INTERVAL_MS = 4_000
    const startedAt = Date.now()
    let lastError = null
    while (Date.now() - startedAt < POLL_DEADLINE_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const stRes = await fetch(`${workerBase}/jobs/${jobId}`, { headers })
      const stBody = await stRes.json().catch(() => ({}))
      if (!stRes.ok) { lastError = stBody?.error || `status ${stRes.status}`; continue }
      if (stBody.status === 'done' && stBody.result?.video_url) {
        const newUrl = stBody.result.video_url
        await supaFetch(`content_scripts?id=eq.${row.id}`, {
          method: 'PATCH',
          body: { media_url_with_cover: newUrl, updated_at: new Date().toISOString() },
          prefer: 'return=minimal',
        }).catch(() => {})
        return res.status(200).json({
          ok: true,
          media_url_with_cover: newUrl,
          duration_secs: stBody.result.duration_secs || 1.0,
        })
      }
      if (stBody.status === 'failed') {
        return res.status(502).json({ error: fmtErr(stBody.error) || 'Cover-intro job failed' })
      }
    }
    // Worker still running past 250s — hand the job id back so the
    // client can keep polling on its own.
    return res.status(202).json({
      job_id: jobId,
      status: 'still_running',
      message: 'Job is still processing. Poll /api/videos/prepend-cover-status?job_id=... to finish.',
      last_error: lastError,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: fmtErr(err) })
  }
}
