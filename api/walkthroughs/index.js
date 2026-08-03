// GET /api/walkthroughs?profile_id=…        → { walkthroughs: [...] }
// GET /api/walkthroughs?id=…                → { walkthrough: {...} }  (status poll)
//
// Read model for the AI Walkthrough builder: list a brand's walkthroughs,
// or fetch one (used to poll generate/render progress).

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

const COLS = 'id,profile_id,topic,title,status,avatar_ref,voice_id,aspect_ratio,script,avatar_video_url,final_url,content_id,render_progress,error,created_at,updated_at'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    const { id, profile_id } = req.query
    if (id) {
      const rows = await supaFetch(`walkthrough_videos?id=eq.${id}&select=${COLS}`)
      const w = rows?.[0]
      if (!w) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, w.profile_id)
      return res.status(200).json({ walkthrough: w })
    }
    if (!profile_id) return res.status(400).json({ error: 'profile_id or id required' })
    await assertProfileAccess(auth.user.id, profile_id)
    const rows = await supaFetch(`walkthrough_videos?profile_id=eq.${profile_id}&order=created_at.desc&limit=50&select=${COLS}`)
    return res.status(200).json({ walkthroughs: rows || [] })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
