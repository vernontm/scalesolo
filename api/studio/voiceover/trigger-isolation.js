// POST /api/studio/voiceover/trigger-isolation
//
// Manually kicks off the fly worker's /jobs/voice-isolate-segments
// endpoint for a given studio_video_id. Used when the auto-trigger
// during initial segmentation didn't land (cold worker, network blip,
// AbortSignal fired before the request reached the worker).
//
// Body: { studio_video_id }
// Returns: { ok, dispatched: true } once the worker acknowledges.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../../_lib/supabase.js'
import { gateStudio } from '../_lib/gate.js'

export const config = { maxDuration: 30 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    gateStudio(auth.user.id)
    const { studio_video_id } = req.body || {}
    if (!studio_video_id) return res.status(400).json({ error: 'studio_video_id required' })

    const rows = await supaFetch(
      `studio_videos?id=eq.${studio_video_id}&select=id,profile_id,voiceover_source_url&limit=1`,
    )
    const video = rows?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)
    if (!video.voiceover_source_url) {
      return res.status(400).json({ error: 'This video is not from an uploaded voiceover — nothing to clean.' })
    }

    const workerUrl = process.env.WORKER_URL
    const workerSecret = process.env.WORKER_SHARED_SECRET
    if (!workerUrl || !workerSecret) {
      return res.status(500).json({ error: 'Worker not configured (WORKER_URL / WORKER_SHARED_SECRET missing).' })
    }

    // Generous timeout — the worker responds immediately after starting
    // the background job (it doesn't wait for isolation to finish), so
    // 15s is plenty to cover a cold-start.
    const r = await fetch(`${workerUrl}/jobs/voice-isolate-segments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': workerSecret,
      },
      body: JSON.stringify({ studio_video_id }),
      signal: AbortSignal.timeout(15000),
    })
    const body = await r.text()
    if (!r.ok) {
      return res.status(r.status).json({
        error: `Worker rejected: ${body.slice(0, 300)}`,
      })
    }
    let parsed
    try { parsed = JSON.parse(body) } catch { parsed = { raw: body } }
    return res.status(200).json({ ok: true, worker: parsed })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
