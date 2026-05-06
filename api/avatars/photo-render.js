// POST /api/avatars/photo-render
// Body: { profile_id, photo_url, script, voice_id?, model_version? }
// Returns: { video_id, avatar_id }
//
// Two-step flow per HeyGen V3 image-to-video docs:
//   1. POST /v3/avatars with the photo URL → renderable avatar id
//   2. POST /v3/videos with avatar_id + script → submitted video id
// Client polls /api/avatars/photo-render-status until completed. Both
// network calls are sync so we stay well under Vercel's function timeout.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { createPhotoAvatarV3, generateVideoV3, MODELS, videoUnitsForModel } from '../_lib/heygen.js'

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
    const { profile_id, photo_url, script, voice_id, model_version } = req.body || {}
    if (!profile_id || !photo_url || !script) {
      return res.status(400).json({ error: 'profile_id + photo_url + script required' })
    }
    await assertProfileAccess(auth.user.id, profile_id)

    const modelKey = model_version || 'v4'
    const modelDef = MODELS[modelKey]
    if (!modelDef) return res.status(400).json({ error: `Unknown model_version: ${modelKey}` })

    const durationSecs = estimateDurationSecs(script)
    const unitsToCharge = videoUnitsForModel(modelKey, durationSecs)

    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    if (customerId) {
      const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.video_units&select=balance`)
      const balance = Number(pools?.[0]?.balance ?? 0)
      if (balance < unitsToCharge) {
        return res.status(402).json({
          error: `Insufficient video units. Need ${unitsToCharge}, have ${balance}.`,
          code: 'insufficient_credits', required: unitsToCharge,
        })
      }
    }

    // Resolve a voice — request body, profile default, or HeyGen default.
    let resolvedVoice = voice_id || ''
    if (!resolvedVoice) {
      const pr = await supaFetch(`profiles?id=eq.${profile_id}&select=elevenlabs_voice_id`)
      resolvedVoice = pr?.[0]?.elevenlabs_voice_id || ''
    }
    if (!resolvedVoice) {
      return res.status(400).json({ error: 'voice_id required (no default voice on this profile)' })
    }

    // Step 1: create photo avatar from URL
    let avatarId
    try {
      const av = await createPhotoAvatarV3({ imageUrl: photo_url, name: `space-${Date.now()}` })
      avatarId = av?.data?.avatar_item?.id || av?.data?.id
      if (!avatarId) throw new Error('HeyGen returned no avatar id')
    } catch (e) {
      return res.status(502).json({ error: `Photo avatar create failed: ${e.message}` })
    }

    // Step 2: submit video render
    let videoId
    try {
      const vr = await generateVideoV3({
        avatarId,
        voiceId: resolvedVoice,
        script,
        modelKey,
      })
      videoId = vr?.data?.video_id || vr?.video_id || vr?.id
      if (!videoId) throw new Error('HeyGen returned no video id')
    } catch (e) {
      return res.status(502).json({ error: `Video submit failed: ${e.message}`, avatar_id: avatarId })
    }

    // Persist a render row (avatar_id is HeyGen's id, not internal — store in metadata).
    let renderRowId = null
    try {
      const renderRow = await supaFetch('avatar_renders', {
        method: 'POST',
        body: {
          profile_id,
          title: script.slice(0, 60),
          script,
          sentences: [],
          status: 'generating_clips',
          model_version: modelKey,
          voice_id: resolvedVoice,
          heygen_video_id: videoId,
          video_units_charged: unitsToCharge,
          duration_secs: durationSecs,
        },
      })
      renderRowId = (Array.isArray(renderRow) ? renderRow[0] : renderRow)?.id || null
    } catch (e) { console.warn('persist render row failed:', e.message) }

    if (customerId) {
      try {
        await supaFetch('rpc/consume_credits', {
          method: 'POST',
          body: {
            p_customer_id: customerId,
            p_pool_type: 'video_units',
            p_amount: unitsToCharge,
            p_action: 'consume:photo-avatar-render',
            p_ref_table: 'avatar_renders',
            p_ref_id: renderRowId,
            p_profile_id: profile_id,
            p_metadata: { model_version: modelKey, photo_url, duration_secs: durationSecs, heygen_video_id: videoId },
          },
        })
      } catch (e) { console.warn('credit consume failed:', e.message) }
    }

    return res.status(200).json({ video_id: videoId, avatar_id: avatarId, render_id: renderRowId })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
