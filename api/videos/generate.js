// POST /api/videos/generate
// Body: { profile_id, prompt, image_urls?, aspect?, duration? }
// Returns: 202 { taskId, model, aspect, duration }  (poll /api/videos/status)
//
// Standalone Veo 3.1 (KIE.ai) video generation, credit-gated the same way as
// /api/images/generate. Text-to-video when image_urls is empty; image-to-video
// (animate a reference photo) when provided. Credits are reserved up-front and
// refunded automatically on any KIE failure, keyed to auth.user.id — so this
// bills the (possibly impersonated) user's ScaleSolo ai_tokens and returns 402
// when the balance is too low.

import { setCors, requireUser, assertMinRole } from '../_lib/supabase.js'
import { withCreditReservation } from '../_lib/credits.js'

const KIE_API_KEY = process.env.KIE_API_KEY
const VEO_MODEL = 'veo3_fast'
// Matches the campaign video fee. Raise alongside a quality-tier model swap.
const VIDEO_FEE_TOKENS = 110000

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, prompt, image_urls, aspect = '9:16', duration = 8 } = req.body || {}
    if (!profile_id || !prompt) return res.status(400).json({ error: 'profile_id + prompt required' })
    await assertMinRole(auth.user.id, profile_id, 'editor')
    if (!KIE_API_KEY) return res.status(500).json({ error: 'KIE_API_KEY not configured. Add it in Vercel env.' })

    const imgs = Array.isArray(image_urls) ? image_urls.filter(Boolean) : []
    const dur = [4, 6, 8].includes(Number(duration)) ? Number(duration) : 8

    return await withCreditReservation({
      userId: auth.user.id,
      poolType: 'ai_tokens',
      amount: VIDEO_FEE_TOKENS,
      action: 'consume:video-gen',
      profileId: profile_id,
      metadata: { model: VEO_MODEL, aspect, duration: dur, prompt: String(prompt).slice(0, 200) },
    }, async ({ refundIfFailed, tagMetadata }) => {
      const body = { prompt: String(prompt).slice(0, 5000), model: VEO_MODEL, aspect_ratio: aspect, duration: dur }
      if (imgs.length) body.imageUrls = imgs
      const r = await fetch('https://api.kie.ai/api/v1/veo/generate', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KIE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await r.text()
      let data = {}; try { data = JSON.parse(text) } catch { data = { raw: text } }
      if (!r.ok || (data?.code && data.code !== 200)) {
        await refundIfFailed()
        return res.status(502).json({ error: (data?.msg || text || 'KIE Veo error').toString().slice(0, 300), kie_status: r.status })
      }
      const taskId = data?.data?.taskId || data?.taskId
      if (!taskId) {
        await refundIfFailed()
        return res.status(502).json({ error: 'KIE Veo returned no taskId', kie_body: data })
      }
      await tagMetadata({ taskId })
      return res.status(202).json({ taskId, model: VEO_MODEL, aspect, duration: dur })
    })
  } catch (err) {
    if (err?.code === 'insufficient_credits') {
      return res.status(402).json({ error: err.message, code: 'insufficient_credits', need: err.need })
    }
    return res.status(err.status || 500).json({ error: err.message })
  }
}
