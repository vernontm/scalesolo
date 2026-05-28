// POST /api/studio/youtube/create-story-graphic
//
// Generates a 9:16 (1080x1920) PNG story graphic for the given Studio
// video using the saved title + summary + selected thumbnail + brand
// colors. Used by the Schedule modal's "Create Story Graphic" button
// to give the user a ready-to-post Instagram / TikTok story image.
//
// Body: { studio_video_id, title, summary, thumbnail_url, eyebrow,
//         cta_button, cta_eyebrow }
// Returns: { url } — public Supabase Storage URL of the rendered PNG.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../../_lib/supabase.js'
import { gateStudio } from '../_lib/gate.js'

export const config = { maxDuration: 60 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    gateStudio(auth.user.id)
    const { studio_video_id, title, summary, thumbnail_url, eyebrow, cta_button, cta_eyebrow } = req.body || {}
    if (!studio_video_id) return res.status(400).json({ error: 'studio_video_id required' })
    if (!title) return res.status(400).json({ error: 'title required' })

    const videos = await supaFetch(`studio_videos?id=eq.${studio_video_id}&select=id,profile_id`)
    const video = videos?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    // Pull brand color + business_name for the graphic accents.
    const profileRows = await supaFetch(
      `profiles?id=eq.${video.profile_id}&select=brand_primary_color,business_name&limit=1`,
    )
    const profile = profileRows?.[0] || {}

    const workerUrl = process.env.WORKER_URL
    const workerSecret = process.env.WORKER_SHARED_SECRET
    if (!workerUrl || !workerSecret) {
      return res.status(500).json({ error: 'Worker not configured (WORKER_URL / WORKER_SHARED_SECRET).' })
    }
    const r = await fetch(`${workerUrl}/jobs/story-graphic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-secret': workerSecret },
      body: JSON.stringify({
        studio_video_id,
        title,
        summary: summary || '',
        thumbnail_url: thumbnail_url || '',
        accent_color: profile.brand_primary_color || '#ef4444',
        brand_name: profile.business_name || '',
        eyebrow: eyebrow || 'NEW VIDEO IS LIVE',
        cta_button: cta_button || 'Watch on YouTube',
        cta_eyebrow: cta_eyebrow || 'Watch the full video on',
      }),
      signal: AbortSignal.timeout(50000),
    })
    const body = await r.text()
    let parsed
    try { parsed = JSON.parse(body) } catch { parsed = { raw: body } }
    if (!r.ok) {
      return res.status(r.status).json({ error: parsed?.error || `Worker error: ${body.slice(0, 300)}` })
    }
    if (!parsed?.url) return res.status(502).json({ error: 'Worker returned no URL.' })
    return res.status(200).json({ url: parsed.url })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
