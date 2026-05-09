// POST /api/avatars/photo-render
// Body: { profile_id, photo_url, script?, audio_url?, avatar_id?, voice_id?, model_version? }
// Returns: { video_id, heygen_avatar_id, render_id }
//
// Two-step HeyGen V3 image-to-video flow:
//   1. POST /v3/avatars (photo) → renderable avatar_id
//   2. POST /v3/videos with that avatar_id + script (or audio_url)
// Client polls /api/avatars/photo-render-status until completed.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { createPhotoAvatarV3, generateVideoV3, MODELS, videoUnitsForModel } from '../_lib/heygen.js'
import { synthesizeToPublicUrl, looksLikeElevenLabsVoiceId } from '../_lib/elevenlabs.js'

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
    const { profile_id, photo_url, script, audio_url, avatar_id, voice_id, model_version } = req.body || {}
    if (!profile_id || !photo_url) {
      return res.status(400).json({ error: 'profile_id + photo_url required' })
    }
    if (!script && !audio_url) {
      return res.status(400).json({ error: 'script or audio_url required' })
    }
    await assertProfileAccess(auth.user.id, profile_id)

    const modelKey = model_version || 'v4'
    const modelDef = MODELS[modelKey]
    if (!modelDef) return res.status(400).json({ error: `Unknown model_version: ${modelKey}` })

    const durationSecs = estimateDurationSecs(script || '')
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

    // Voice resolution. Same two-path logic as /api/avatars/render:
    //   • ElevenLabs path: synthesize TTS → upload → pass URL as audio_url.
    //   • HeyGen-native: send voice_id directly to HeyGen TTS.
    // audio_url in the request body always wins.
    let resolvedAudioUrl = audio_url || null
    let heygenVoiceId = ''
    let elevenLabsVoice = null

    if (!resolvedAudioUrl) {
      const explicitElevenLabs = voice_id && looksLikeElevenLabsVoiceId(voice_id)
      if (avatar_id) {
        try {
          const aRows = await supaFetch(`avatars?id=eq.${avatar_id}&select=elevenlabs_voice_id`)
          elevenLabsVoice = aRows?.[0]?.elevenlabs_voice_id || null
        } catch {}
      }
      if (!elevenLabsVoice && explicitElevenLabs) elevenLabsVoice = voice_id

      if (elevenLabsVoice && script) {
        try {
          resolvedAudioUrl = await synthesizeToPublicUrl(elevenLabsVoice, script, profile_id)
        } catch (e) {
          return res.status(502).json({
            error: `ElevenLabs TTS failed: ${e.message}. Check ELEVENLABS_API_KEY and that voice "${elevenLabsVoice}" exists in your ElevenLabs account.`,
          })
        }
      } else {
        // Fall back to HeyGen TTS via voice_id (only if it isn't ElevenLabs-shaped).
        heygenVoiceId = (!explicitElevenLabs ? voice_id : '') || ''
        if (!heygenVoiceId) {
          return res.status(400).json({
            error: 'No voice set. Open the Avatars page and add an ElevenLabs voice, or wire an audio file in.',
          })
        }
      }
    }

    // Step 1: create photo avatar from URL
    let heygenAvatarId
    try {
      const av = await createPhotoAvatarV3({ imageUrl: photo_url, name: `space-${Date.now()}` })
      heygenAvatarId = av?.data?.avatar_item?.id || av?.data?.id
      if (!heygenAvatarId) throw new Error('HeyGen returned no avatar id')
    } catch (e) {
      return res.status(502).json({ error: `Photo avatar create failed: ${e.message}` })
    }

    // HeyGen accepts the avatar create call instantly but image dimension
    // extraction happens behind the scenes. Submitting /v3/videos too fast
    // returns "Talking photo X has missing image dimensions". Wait, then
    // retry up to 6 times on warmup-race errors (was 3) — in practice it
    // can take up to ~30s for a fresh upload to be ready.
    await new Promise((r) => setTimeout(r, 5000))

    let videoId
    let lastErr = null
    const RETRY_DELAYS_MS = [8000, 8000, 10000, 10000, 12000]   // total ~50s warmup window
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const vr = await generateVideoV3({
          avatarId: heygenAvatarId,
          voiceId: heygenVoiceId,
          script,
          audioUrl: resolvedAudioUrl,
          modelKey,
        })
        videoId = vr?.data?.video_id || vr?.video_id || vr?.id
        if (videoId) break
        throw new Error('HeyGen returned no video id')
      } catch (e) {
        lastErr = e
        const msg = String(e?.message || '')
        // Only retry on the dimension-warmup race; bail on other errors.
        if (!/missing image dimensions|not ready/i.test(msg)) break
        const delay = RETRY_DELAYS_MS[attempt] ?? 12000
        await new Promise((r) => setTimeout(r, delay))
      }
    }
    if (!videoId) {
      return res.status(502).json({
        error: `Video submit failed: ${lastErr?.message || 'unknown'}`,
        heygen_avatar_id: heygenAvatarId,
        hint: /missing image dimensions/i.test(lastErr?.message || '')
          ? 'HeyGen could not read this photo\'s dimensions. Re-save the look image as a standard JPG / PNG and try again.'
          : undefined,
      })
    }

    // Persist a render row.
    let renderRowId = null
    try {
      const renderRow = await supaFetch('avatar_renders', {
        method: 'POST',
        body: {
          profile_id,
          avatar_id: avatar_id || null,    // optional FK to internal avatars row
          title: (script || 'audio render').slice(0, 60),
          script: script || null,
          sentences: [],
          status: 'generating_clips',
          model_version: modelKey,
          voice_id: heygenVoiceId || elevenLabsVoice || null,
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
            p_metadata: { model_version: modelKey, photo_url, duration_secs: durationSecs, heygen_video_id: videoId, audio: !!audio_url },
          },
        })
      } catch (e) { console.warn('credit consume failed:', e.message) }
    }

    return res.status(200).json({ video_id: videoId, heygen_avatar_id: heygenAvatarId, render_id: renderRowId })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
