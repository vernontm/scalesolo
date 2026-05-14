// POST /api/videos/normalize
// Body: { profile_id, video_url, force?: bool }
// Returns: { video_url, normalized, reason, bytes, probe, source_bytes? }
//
// Thin proxy → Fly worker /jobs/normalize-video. Used by the "Compress"
// button on Bulk Upload rows to swap a weird source video (4K HEVC HDR
// iPhone .mov, 60fps slo-mo, sideways portrait, etc.) for a canonical
// 1080p / 30fps / 8-bit H.264 MP4 that polish, captions, and Upload-Post
// all consume reliably.
//
// Already-canonical sources short-circuit on the worker side — same URL
// echoed back, no re-encode, no extra charge.

import { setCors, requireUser, assertProfileAccess } from '../_lib/supabase.js'

export const config = { maxDuration: 300 }

export default async function handler(req, res) {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST')     return res.status(405).json({ error: 'Method not allowed' })

  try {
    const auth = await requireUser(req)
    const { profile_id, video_url, force } = req.body || {}
    if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
    if (!video_url)  return res.status(400).json({ error: 'video_url required' })
    await assertProfileAccess(auth.user.id, profile_id)

    const WORKER_URL    = process.env.WORKER_URL
    const WORKER_SECRET = process.env.WORKER_SHARED_SECRET
    if (!WORKER_URL) return res.status(503).json({ error: 'Video normalize requires the worker (WORKER_URL not configured)' })

    const r = await fetch(`${WORKER_URL.replace(/\/$/, '')}/jobs/normalize-video`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WORKER_SECRET ? { 'x-worker-secret': WORKER_SECRET } : {}),
      },
      body: JSON.stringify({ profile_id, video_url, force: !!force }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) {
      return res.status(r.status || 502).json({ error: body?.error || `Worker error ${r.status}` })
    }
    return res.status(200).json(body)
  } catch (err) {
    console.error('videos/normalize error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
