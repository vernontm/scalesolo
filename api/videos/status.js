// GET /api/videos/status?taskId=...&profile_id=... → { state, url? }
//
// Polls one KIE Veo task. On success, mirrors the video to Supabase storage and
// returns the mirrored URL. On failure, refunds the consume:video-gen for this
// taskId (idempotent). Client/MCP loops on this until state is success/failed.

import { setCors, requireUser } from '../_lib/supabase.js'
import { mirrorToStorage } from '../images/_mirror.js'
import { refundConsumeByMetadata } from '../_lib/credits.js'

const KIE_API_KEY = process.env.KIE_API_KEY

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  const taskId = req.query.taskId
  const profile_id = req.query.profile_id
  if (!taskId) return res.status(400).json({ error: 'taskId required' })
  if (!KIE_API_KEY) return res.status(500).json({ error: 'KIE_API_KEY not configured' })

  try {
    const r = await fetch(`https://api.kie.ai/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${KIE_API_KEY}` },
    })
    const text = await r.text()
    let body = {}; try { body = JSON.parse(text) } catch { body = { raw: text } }
    const data = body?.data || {}
    // Veo: successFlag 0 generating, 1 success, 2/3 failed. Video at
    // data.response.resultUrls.
    const flag = Number(data?.successFlag)

    if (flag === 1) {
      const resp = data?.response || {}
      const urls = resp.resultUrls || resp.fullResultUrls || resp.originUrls || []
      const url = Array.isArray(urls) ? (typeof urls[0] === 'string' ? urls[0] : urls[0]?.url) : null
      if (!url) return res.status(502).json({ state: 'failed', error: 'Veo returned no video URL', kie_body: data })
      let finalUrl = url
      try { finalUrl = await mirrorToStorage(url, profile_id) } catch { /* fall back to KIE URL */ }
      return res.status(200).json({ state: 'success', url: finalUrl })
    }

    if (flag === 2 || flag === 3) {
      try {
        await refundConsumeByMetadata({
          originalAction: 'consume:video-gen',
          metadataKey: 'taskId',
          metadataValue: taskId,
          profileId: profile_id || null,
        })
      } catch (e) { console.error('video-gen refund failed:', taskId, e?.message) }
      return res.status(200).json({ state: 'failed', error: data?.errorMessage || data?.failMsg || data?.msg || 'Veo generation failed' })
    }

    return res.status(200).json({ state: 'pending' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
