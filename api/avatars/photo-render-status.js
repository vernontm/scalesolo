// GET /api/avatars/photo-render-status?video_id=...
// Polls HeyGen's /v3/videos/{id} once. Returns:
//   { state: 'pending' | 'processing' | 'success' | 'failed', video_url?, error? }

import { setCors, requireUser } from '../_lib/supabase.js'
import { getVideoStatusV3Direct } from '../_lib/heygen.js'
import { refundConsumeByMetadata } from '../_lib/credits.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  const videoId = req.query.video_id
  if (!videoId) return res.status(400).json({ error: 'video_id required' })

  try {
    const r = await getVideoStatusV3Direct(videoId)
    const data = r?.data || r
    const status = String(data?.status || '').toLowerCase()
    if (status === 'completed' || status === 'success' || status === 'done') {
      const url = data?.video_url || data?.video_url_caption || data?.url
      if (!url) return res.status(200).json({ state: 'failed', error: 'No video URL on completed render' })
      return res.status(200).json({ state: 'success', video_url: url })
    }
    if (status === 'failed' || status === 'error') {
      // Refund the consume:photo-avatar-render keyed on heygen_video_id.
      // Idempotent so repeat polls only refund once.
      try {
        const refund = await refundConsumeByMetadata({
          originalAction: 'consume:photo-avatar-render',
          metadataKey: 'heygen_video_id',
          metadataValue: videoId,
        })
        if (refund.refunded) console.log('photo-render refund:', { videoId, amount: refund.amount })
      } catch (e) {
        console.error('photo-render refund failed:', videoId, e?.message)
      }
      return res.status(200).json({ state: 'failed', error: data?.failure_message || data?.error?.message || 'Render failed' })
    }
    return res.status(200).json({ state: status || 'pending' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
