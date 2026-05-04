// GET /api/avatars/render-status?id=<avatar_renders.id>
// Polls HeyGen for the latest status and updates the row.
import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { getVideoStatus } from '../_lib/heygen.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const id = req.query.id
    if (!id) return res.status(400).json({ error: 'id required' })
    const rows = await supaFetch(`avatar_renders?id=eq.${id}&select=*`)
    const render = rows?.[0]
    if (!render) return res.status(404).json({ error: 'Not found' })
    await assertProfileAccess(auth.user.id, render.profile_id)

    if (!render.heygen_video_id || render.status === 'done' || render.status === 'failed') {
      return res.status(200).json({ render })
    }

    const status = await getVideoStatus(render.heygen_video_id).catch((e) => ({ error: e.message }))
    const heygenStatus = status?.data?.status   // 'pending' | 'processing' | 'completed' | 'failed'
    const videoUrl = status?.data?.video_url
    const errorReason = status?.data?.error?.message

    let nextStatus = render.status
    let updates = {}
    if (heygenStatus === 'completed' && videoUrl) {
      nextStatus = 'done'
      updates = { status: 'done', final_video_url: videoUrl }
    } else if (heygenStatus === 'failed') {
      nextStatus = 'failed'
      updates = { status: 'failed', error: errorReason || 'HeyGen render failed' }
    } else if (heygenStatus === 'processing') {
      updates = { status: 'generating_clips' }
    }

    if (Object.keys(updates).length) {
      await supaFetch(`avatar_renders?id=eq.${id}`, { method: 'PATCH', body: updates, prefer: 'return=minimal' })
    }

    return res.status(200).json({ render: { ...render, ...updates }, heygen_status: heygenStatus, video_url: videoUrl })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
