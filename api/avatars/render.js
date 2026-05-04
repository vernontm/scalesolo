// POST /api/avatars/render
// Body: { avatar_id, script, voice_id?, look_id?, model_version? }
//
// Pre-flight credit check, submit HeyGen video.generate, persist render row,
// debit video_units (estimated from script length × words-per-sec heuristic).
//
// Status polling is in /api/avatars/render-status.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { generateVideo, MODELS, videoUnitsForModel } from '../_lib/heygen.js'

// Rough heuristic: 2.5 words per second of spoken English.
function estimateDurationSecs(script) {
  const words = (script || '').trim().split(/\s+/).filter(Boolean).length
  return Math.max(3, Math.round(words / 2.5))
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { avatar_id, script, voice_id, look_id, model_version } = req.body || {}
    if (!avatar_id || !script) return res.status(400).json({ error: 'avatar_id + script required' })

    const aRows = await supaFetch(`avatars?id=eq.${avatar_id}&select=*`)
    const avatar = aRows?.[0]
    if (!avatar) return res.status(404).json({ error: 'Avatar not found' })
    await assertProfileAccess(auth.user.id, avatar.profile_id)

    const modelKey = model_version || avatar.model_version || 'v4'
    const durationSecs = estimateDurationSecs(script)
    const unitsToCharge = videoUnitsForModel(modelKey, durationSecs)

    // Pre-flight credit check
    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    if (customerId) {
      const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.video_units&select=balance`)
      const balance = Number(pools?.[0]?.balance ?? 0)
      if (balance < unitsToCharge) {
        return res.status(402).json({
          error: `Insufficient video units. Need ${unitsToCharge}, have ${balance}.`,
          code: 'insufficient_credits',
          required: unitsToCharge,
        })
      }
    }

    // Resolve which talking_photo to use:
    // - if look_id is provided AND the look has a heygen_look_id → use it
    // - else use the avatar's primary talking_photo_id
    let talkingPhotoId = avatar.talking_photo_id
    if (look_id) {
      const lkRows = await supaFetch(`avatar_looks?id=eq.${look_id}&select=heygen_look_id`)
      const heygenLookId = lkRows?.[0]?.heygen_look_id
      if (heygenLookId) talkingPhotoId = heygenLookId
    }
    if (!talkingPhotoId && !avatar.heygen_group_id) {
      return res.status(400).json({ error: 'Avatar has no HeyGen talking_photo or avatar_id (training may have failed). Re-create the avatar.' })
    }

    const resolvedVoice = voice_id || avatar.elevenlabs_voice_id || ''
    if (!resolvedVoice) return res.status(400).json({ error: 'voice_id required (avatar has no default voice)' })

    // Submit to HeyGen
    let heygenVideoId
    try {
      const resp = await generateVideo({
        talkingPhotoId,
        voiceId: resolvedVoice,
        script,
      })
      heygenVideoId = resp?.data?.video_id || resp?.video_id
      if (!heygenVideoId) throw new Error(`HeyGen returned no video_id (${JSON.stringify(resp).slice(0, 200)})`)
    } catch (e) {
      return res.status(502).json({ error: `HeyGen render submit failed: ${e.message}` })
    }

    // Persist the render row
    const renderRow = await supaFetch('avatar_renders', {
      method: 'POST',
      body: {
        avatar_id,
        profile_id: avatar.profile_id,
        title: script.slice(0, 60),
        script,
        sentences: [],
        status: 'generating_clips',
        model_version: modelKey,
        voice_id: resolvedVoice,
        heygen_video_id: heygenVideoId,
        video_units_charged: unitsToCharge,
        duration_secs: durationSecs,
      },
    })
    const render = Array.isArray(renderRow) ? renderRow[0] : renderRow

    // Debit credits AFTER persistence so we have the ref_id
    if (customerId) {
      try {
        await supaFetch('rpc/consume_credits', {
          method: 'POST',
          body: {
            p_customer_id: customerId,
            p_pool_type: 'video_units',
            p_amount: unitsToCharge,
            p_action: 'consume:avatar-render',
            p_ref_table: 'avatar_renders',
            p_ref_id: render.id,
            p_profile_id: avatar.profile_id,
            p_metadata: { model_version: modelKey, duration_secs: durationSecs, heygen_video_id: heygenVideoId },
          },
        })
      } catch (e) { console.warn('credit consume failed', e.message) }
    }

    return res.status(200).json({
      render,
      heygen_video_id: heygenVideoId,
      duration_secs: durationSecs,
      units_charged: unitsToCharge,
      cost_estimate_usd: ((MODELS[modelKey]?.cents_per_sec || 12) * durationSecs / 100).toFixed(2),
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
