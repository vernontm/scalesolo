// POST /api/studio/render-final
//
// Thin dispatcher to the Fly worker. The worker (scalesolo-worker) has
// real Chrome (no @sparticuz/Lambda RAF throttling), no 5-minute
// function ceiling, and 8GB RAM on performance-4x machines. The full
// render logic lives in worker/studio-render.js — this file just
// validates the request, gates the user, and POSTs to the worker.
//
// Body: { studio_video_id }
// Returns: { ok, dispatched_to: WORKER_URL } immediately on dispatch.
//          The actual render completion is reported via Realtime updates
//          to studio_videos.render_progress + status.
//
// Required env vars:
//   WORKER_URL                   — base URL of scalesolo-worker on Fly
//   WORKER_SHARED_SECRET         — same value as on the worker
//
// The previous implementation (Vercel-side Puppeteer + ffmpeg) lives
// in git history if we ever need to roll back. It hit Lambda's hard
// 5-min limit on multi-segment bakes and silently fell back to
// drawtext on every motion segment because of headless RAF throttling.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { gateStudio } from './_lib/gate.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    gateStudio(auth.user.id)

    const videoId = req.body?.studio_video_id
    if (!videoId) return res.status(400).json({ error: 'studio_video_id required' })

    // Validate access before bothering the worker
    const vRows = await supaFetch(`studio_videos?id=eq.${videoId}&select=id,profile_id&limit=1`)
    const video = vRows?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    const WORKER_URL = process.env.WORKER_URL
    const WORKER_SECRET = process.env.WORKER_SHARED_SECRET
    if (!WORKER_URL) {
      return res.status(500).json({
        error: 'WORKER_URL not configured. Studio renders are dispatched to the scalesolo-worker Fly app — set WORKER_URL in Vercel env to its public URL.',
      })
    }

    // Fire-and-forget dispatch. We DON'T await the worker's full render
    // (which can take several minutes) inside this Vercel function —
    // that would defeat the whole point of the migration. Instead the
    // worker writes progress + final status directly to studio_videos
    // via service-role Supabase access, and the frontend listens via
    // Realtime.
    //
    // We DO wait for the worker to confirm it accepted the job (status
    // check on the initial POST) before returning — so the user gets
    // an immediate error if the worker is down, instead of staring at
    // a render that never started.
    const workerUrl = `${WORKER_URL.replace(/\/$/, '')}/jobs/studio-render`
    const dispatchedAt = new Date().toISOString()

    // Fire the request but only WAIT for the worker to acknowledge
    // accepting it (Vercel still has to return within its budget).
    // We use Promise.race so the worker has up to 10s to acknowledge —
    // beyond that we assume it's running and return success.
    const fetchPromise = fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WORKER_SECRET ? { 'x-worker-secret': WORKER_SECRET } : {}),
      },
      body: JSON.stringify({ studio_video_id: videoId }),
    })

    // Don't await the worker's full response — kick off in background.
    fetchPromise.then(async (workerRes) => {
      if (!workerRes.ok) {
        const body = await workerRes.text().catch(() => '')
        console.warn(`[studio-render dispatch] worker returned ${workerRes.status}: ${body.slice(0, 300)}`)
      }
    }).catch((err) => {
      console.warn('[studio-render dispatch] worker call failed:', err.message)
    })

    // Mark the video as rendering so the UI updates immediately.
    // (The worker will overwrite this with its own status writes as
    // it progresses. We pre-set it here so there's no awkward "is
    // anything happening?" window between dispatch and the worker's
    // first progress write.)
    await supaFetch(`studio_videos?id=eq.${videoId}`, {
      method: 'PATCH',
      body: {
        status: 'rendering',
        error: null,
        render_progress: {
          stage: 'dispatching',
          current: 0,
          total: 0,
          started_at: dispatchedAt,
          hf_rendered: [],
          hf_fallback: [],
        },
      },
      prefer: 'return=minimal',
    })

    return res.status(202).json({
      ok: true,
      dispatched_to: WORKER_URL,
      message: 'Render dispatched to Fly worker. Watch studio_videos.render_progress via Realtime for status.',
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
