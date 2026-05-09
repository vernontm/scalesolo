// GET /api/avatars/render-status?id=<avatar_renders.id>
// Polls HeyGen — uses /v3/videos/{id} for V4/V5 renders, legacy
// /v1/video_status.get for V3.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { getVideoStatusForEngine, MODELS } from '../_lib/heygen.js'
import { refundConsumeByMetadata } from '../_lib/credits.js'

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

    const engine = MODELS[render.model_version]?.engine || 'v2_legacy'
    const status = await getVideoStatusForEngine(render.heygen_video_id, engine).catch((e) => ({ error: e.message }))

    // v2 status shape:  status.data.status: 'pending'|'processing'|'completed'|'failed', video_url
    // v3 status shape:  status.data.status: 'pending'|'processing'|'completed'|'failed', video_url
    const heygenStatus = status?.data?.status
    const videoUrl = status?.data?.video_url
    const errorReason = status?.data?.error?.message || status?.error

    let updates = {}
    if (heygenStatus === 'completed' && videoUrl) {
      updates = { status: 'done', final_video_url: videoUrl }
    } else if (heygenStatus === 'failed') {
      updates = { status: 'failed', error: errorReason || 'HeyGen render failed' }
    } else if (heygenStatus === 'processing') {
      updates = { status: 'generating_clips' }
    }

    if (Object.keys(updates).length) {
      await supaFetch(`avatar_renders?id=eq.${id}`, { method: 'PATCH', body: updates, prefer: 'return=minimal' })
    }

    // Refund the consume:photo-avatar-render when HeyGen reports a
    // terminal failure. The original consume metadata records
    // heygen_video_id (see api/avatars/photo-render.js consume site)
    // so refundConsumeByMetadata finds the right transaction.
    // Idempotent — polling the failed render multiple times only
    // refunds once.
    if (updates.status === 'failed') {
      try {
        const refund = await refundConsumeByMetadata({
          originalAction: 'consume:photo-avatar-render',
          metadataKey: 'heygen_video_id',
          metadataValue: render.heygen_video_id,
          profileId: render.profile_id,
        })
        if (refund.refunded) console.log('avatar-render refund:', { id, heygen_video_id: render.heygen_video_id, amount: refund.amount })
      } catch (e) {
        console.error('avatar-render refund failed:', id, e?.message)
      }
    }

    return res.status(200).json({
      render: { ...render, ...updates },
      engine,
      heygen_status: heygenStatus,
      video_url: videoUrl,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
