// POST /api/avatars/render
// Body: { avatar_id, script, voice_id?, look_id?, model_version? }
// Dispatches to the correct HeyGen API based on model_version:
//   v3 → /v2/video/generate (Avatar III legacy)
//   v4 → /v3/videos (Avatar IV)
//   v5 → /v3/videos with expressiveness=high + motion_prompt (Avatar V)

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { generateVideoV2, generateVideoV3, MODELS, videoUnitsForModel } from '../_lib/heygen.js'

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

    // Refuse early if HeyGen training isn't complete. We surface a clean
    // message instead of letting HeyGen 404 deep in the render submit.
    if (avatar.training_status && !['ready', 'completed', 'success'].includes(avatar.training_status)) {
      return res.status(409).json({
        error: avatar.training_status === 'training'
          ? 'This avatar is still being processed by HeyGen. Wait a few minutes and try again, or use a HeyGen library avatar.'
          : `Avatar training did not finish (${avatar.training_status}). Re-create the avatar from the Avatars page.`,
        training_status: avatar.training_status,
      })
    }

    const modelKey = model_version || avatar.model_version || 'v4'
    const modelDef = MODELS[modelKey]
    if (!modelDef) return res.status(400).json({ error: `Unknown model_version: ${modelKey}` })

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

    // Resolve the avatar identifier:
    //   - Look-specific override (heygen_look_id) when a look is selected
    //   - Otherwise the avatar's primary talking_photo_id (works for v2 and v3)
    let avatarIdForApi = avatar.talking_photo_id
    if (look_id) {
      const lkRows = await supaFetch(`avatar_looks?id=eq.${look_id}&select=heygen_look_id`)
      const heygenLookId = lkRows?.[0]?.heygen_look_id
      if (heygenLookId) avatarIdForApi = heygenLookId
    }
    if (!avatarIdForApi) {
      return res.status(400).json({ error: 'Avatar has no HeyGen ID (training may have failed). Re-create the avatar.' })
    }

    const resolvedVoice = voice_id || avatar.elevenlabs_voice_id || ''
    if (!resolvedVoice) return res.status(400).json({ error: 'voice_id required (avatar has no default voice)' })

    // Dispatch by engine
    let heygenVideoId
    try {
      if (modelDef.engine === 'v2_legacy') {
        const resp = await generateVideoV2({
          talkingPhotoId: avatarIdForApi,
          voiceId: resolvedVoice,
          script,
        })
        heygenVideoId = resp?.data?.video_id || resp?.video_id
      } else {
        const resp = await generateVideoV3({
          avatarId: avatarIdForApi,
          voiceId: resolvedVoice,
          script,
          modelKey,
        })
        heygenVideoId = resp?.data?.video_id || resp?.video_id || resp?.id
      }
      if (!heygenVideoId) throw new Error('HeyGen returned no video_id')
    } catch (e) {
      // If HeyGen 404s on the avatar id, our stored id was probably an
      // intermediate generation_id (HeyGen's photo-avatar pipeline shifted
      // and now returns generation_id from /photo/generate). Give the user
      // an actionable message instead of the raw HTTP error.
      const looksLikeNotFound = e.status === 404 || /avatar not found/i.test(e.message || '')
      if (looksLikeNotFound) {
        return res.status(409).json({
          error: 'This avatar is not yet usable on HeyGen — its training has not produced a final avatar id. Pick a different avatar (from the HeyGen library) or re-upload after HeyGen finishes processing.',
          engine: modelDef.engine,
          heygen_id_used: avatarIdForApi,
        })
      }
      return res.status(502).json({ error: `HeyGen render submit failed: ${e.message}`, engine: modelDef.engine })
    }

    // Persist render row
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
            p_metadata: {
              model_version: modelKey,
              engine: modelDef.engine,
              duration_secs: durationSecs,
              heygen_video_id: heygenVideoId,
            },
          },
        })
      } catch (e) { console.warn('credit consume failed', e.message) }
    }

    return res.status(200).json({
      render,
      heygen_video_id: heygenVideoId,
      engine: modelDef.engine,
      duration_secs: durationSecs,
      units_charged: unitsToCharge,
      cost_estimate_usd: ((modelDef.cents_per_sec || 12) * durationSecs / 100).toFixed(2),
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
