// POST /api/videos/combine-av
// Body: { profile_id, video_url, audio_url, loop_video?: bool }
// Returns: { video_url, bytes }
//
// Proxies to the Fly worker /jobs/combine-av endpoint. Combine audio +
// video into one mp4 (-c:v copy, fast). Used by the "Combine" node on
// the canvas to merge b-roll uploads with voice_gen audio before
// passing the combined clip to video_polish.

import { setCors, requireUser, assertProfileAccess } from '../_lib/supabase.js'

export const config = { maxDuration: 60 }

const WORKER_URL = process.env.WORKER_URL
const WORKER_SECRET = process.env.WORKER_SHARED_SECRET

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, video_url, audio_url, loop_video = true } = req.body || {}
    if (!profile_id || !video_url || !audio_url) {
      return res.status(400).json({ error: 'profile_id + video_url + audio_url required' })
    }
    if (!WORKER_URL) return res.status(500).json({ error: 'WORKER_URL not configured' })
    await assertProfileAccess(auth.user.id, profile_id)

    const r = await fetch(`${WORKER_URL.replace(/\/$/, '')}/jobs/combine-av`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WORKER_SECRET ? { 'x-worker-secret': WORKER_SECRET } : {}),
      },
      body: JSON.stringify({ profile_id, video_url, audio_url, loop_video }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) return res.status(502).json({ error: body?.error || `Worker ${r.status}` })
    return res.status(200).json(body)
  } catch (err) {
    console.error('combine-av error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
