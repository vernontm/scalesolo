// POST /api/avatars/render
// Body: { avatar_id, script, voice_id?, look_id?, model_version? }
// Dispatches to the correct HeyGen API based on model_version:
//   v3 → /v2/video/generate (Avatar III legacy)
//   v4 → /v3/videos (Avatar IV)
//   v5 → /v3/videos with expressiveness=high + motion_prompt (Avatar V)

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { generateVideoV2, generateVideoV3, MODELS, videoUnitsForModel, listLooksForGroup } from '../_lib/heygen.js'
import { synthesizeToPublicUrl, looksLikeElevenLabsVoiceId, resolveByoApiKey, sanitizeVoiceSettings, chargeTtsCredits } from '../_lib/elevenlabs.js'
import { isUserOnTrial, TRIAL_LOCKS } from '../_lib/billing.js'

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
    const { avatar_id, script, audio_url, voice_id, look_id, model_version } = req.body || {}
    if (!avatar_id) return res.status(400).json({ error: 'avatar_id required' })
    if (!script && !audio_url) return res.status(400).json({ error: 'script or audio_url required' })

    // Public-library avatars are passed through as `pub:<heygen_group_id>`.
    // Skip the Supabase lookup and render directly via the V3 endpoint.
    const isPublic = typeof avatar_id === 'string' && avatar_id.startsWith('pub:')
    let avatar = null
    if (!isPublic) {
      const aRows = await supaFetch(`avatars?id=eq.${avatar_id}&select=*`)
      avatar = aRows?.[0]
      if (!avatar) return res.status(404).json({ error: 'Avatar not found' })
      await assertProfileAccess(auth.user.id, avatar.profile_id)

      // Refuse early if HeyGen training isn't complete.
      if (avatar.training_status && !['ready', 'completed', 'success'].includes(avatar.training_status)) {
        return res.status(409).json({
          error: avatar.training_status === 'training'
            ? 'This avatar is still being processed by HeyGen. Wait a few minutes and try again, or use a HeyGen library avatar.'
            : `Avatar training did not finish (${avatar.training_status}). Re-create the avatar from the Avatars page.`,
          training_status: avatar.training_status,
        })
      }
    } else {
      // Need a profile to charge credits against — require it on the request.
      if (!req.body?.profile_id) {
        return res.status(400).json({ error: 'profile_id required when using a public avatar' })
      }
      await assertProfileAccess(auth.user.id, req.body.profile_id)
      avatar = {
        profile_id: req.body.profile_id,
        talking_photo_id: avatar_id.slice(4), // raw HeyGen group/avatar id
        model_version: 'v4',
        elevenlabs_voice_id: '',
      }
    }

    // Trial enforcement. Forces V4 + 30-second hard cap regardless of
    // what the client sent. Caller can't sneak past it from the
    // canvas — the server is the only source of truth. Watermark
    // lock is applied later by the polish step (it reads the same
    // helper).
    const onTrial = await isUserOnTrial(auth.user.id)
    const modelKey = onTrial ? TRIAL_LOCKS.forced_model
      : (model_version || avatar.model_version || 'v4')
    const modelDef = MODELS[modelKey]
    if (!modelDef) return res.status(400).json({ error: `Unknown model_version: ${modelKey}` })

    const rawDuration = estimateDurationSecs(script)
    const durationSecs = onTrial ? Math.min(rawDuration, TRIAL_LOCKS.max_duration_secs) : rawDuration
    const unitsToCharge = videoUnitsForModel(modelKey, durationSecs)

    // Pre-flight credit check. Hard wall — if the user doesn't have
    // a billing customer record OR their balance is short, we BAIL
    // BEFORE calling HeyGen. Without this check a user with no
    // credits would still trigger a HeyGen render (and a real bill
    // on our end) and only fail post-charge. The 402 / code:
    // 'insufficient_credits' shape is what the canvas listens for to
    // pop the top-up / upgrade modal.
    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    if (!customerId) {
      return res.status(402).json({
        error: 'No active subscription. Pick a plan to start rendering videos.',
        code: 'insufficient_credits',
        required: unitsToCharge,
        have: 0,
      })
    }
    const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.video_units&select=balance`)
    const balance = Number(pools?.[0]?.balance ?? 0)
    if (balance < unitsToCharge) {
      return res.status(402).json({
        error: `Not enough video credits — this render needs ${unitsToCharge}, you have ${balance}. Top up or upgrade to keep going.`,
        code: 'insufficient_credits',
        required: unitsToCharge,
        have: balance,
      })
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
    // Public-library avatars come in as a group_id, not a renderable avatar
    // id. HeyGen's /v3/videos expects a specific avatar inside the group, so
    // fetch the group's looks, pick the first, and grab its default voice.
    let publicDefaultVoice = ''
    if (isPublic) {
      try {
        const looksResp = await listLooksForGroup(avatarIdForApi)
        const looks = looksResp?.data?.avatar_list || looksResp?.data || []
        const first = Array.isArray(looks) ? looks[0] : null
        const firstAvatarId = first?.avatar_id || first?.id || first?.avatar_v3_id
        if (firstAvatarId) avatarIdForApi = firstAvatarId
        publicDefaultVoice =
          first?.default_voice_id ||
          first?.voice_id ||
          first?.normal_preview?.voice_id ||
          ''
      } catch (e) {
        return res.status(502).json({ error: `Could not list HeyGen looks for this avatar: ${e.message}` })
      }
    }
    if (!avatarIdForApi) {
      return res.status(400).json({ error: 'Avatar has no HeyGen ID (training may have failed). Re-create the avatar.' })
    }

    // Voice resolution. Two distinct paths:
    //
    //   • ElevenLabs path: when avatar.elevenlabs_voice_id is set (or the
    //     caller explicitly passed an ElevenLabs-shaped voice_id), synthesize
    //     the script via ElevenLabs first, upload to storage, and pass the
    //     resulting URL to HeyGen as audio_url. HeyGen then lip-syncs to our
    //     audio instead of running its own TTS — its TTS endpoint rejects
    //     ElevenLabs voice IDs with a 400 "Voice not found".
    //
    //   • HeyGen-native path: voice_id from the request body (or the public
    //     avatar's default_voice_id) goes directly to HeyGen for TTS.
    //
    // audio_url in the request body always wins (already-synthesized audio
    // pipes straight through, no TTS layer).
    let resolvedAudioUrl = audio_url || null
    let heygenVoiceId = ''

    const explicitElevenLabs = voice_id && looksLikeElevenLabsVoiceId(voice_id)
    const elevenLabsVoice = avatar.elevenlabs_voice_id || (explicitElevenLabs ? voice_id : null)

    if (!resolvedAudioUrl && elevenLabsVoice && script) {
      try {
        // BYOK avatars resolve voices under the user's own ElevenLabs
        // key, not ours. avatar.voice_owner = 'byok' flips the lookup.
        let apiKey = null
        if (avatar.voice_owner === 'byok') {
          apiKey = await resolveByoApiKey(avatar.profile_id)
          if (!apiKey) {
            return res.status(401).json({
              error: 'This avatar uses a voice from your own ElevenLabs workspace, but the API key for this brand profile isn\'t connected. Connect it under Avatar → Choose voice → Connect ElevenLabs.',
            })
          }
        }
        // Per-avatar voice tuning. avatar.voice_settings + voice_model_id
        // come from the avatar editor's Voice section. sanitizeVoiceSettings
        // clamps any out-of-range jsonb to ElevenLabs' supported ranges.
        const tuningOpts = {}
        const cleaned = sanitizeVoiceSettings(avatar.voice_settings)
        if (cleaned) tuningOpts.voice_settings = cleaned
        if (typeof avatar.voice_model_id === 'string' && avatar.voice_model_id.trim()) {
          tuningOpts.model_id = avatar.voice_model_id.trim()
        }
        // Default to English when the avatar hasn't been explicitly
        // set so older renders don't keep drifting. Migration 0026
        // backfilled existing rows; this protects new ones too.
        const lang = (avatar.voice_language || 'en').trim()
        if (lang) tuningOpts.language_code = lang
        resolvedAudioUrl = await synthesizeToPublicUrl(
          elevenLabsVoice, script, avatar.profile_id,
          { ...(apiKey ? { apiKey } : {}), ...tuningOpts },
        )
        // Charge TTS tokens scaled by model. Best-effort — any failure
        // logs and swallows so a billing hiccup never breaks a render.
        await chargeTtsCredits({
          userId: auth.user.id,
          profileId: avatar.profile_id,
          modelId: avatar.voice_model_id,
          charCount: script.length,
          refTable: 'avatars',
          refId: avatar.id,
          kind: 'render',
        })
      } catch (e) {
        return res.status(502).json({
          error: `ElevenLabs TTS failed: ${e.message}. Check that voice "${elevenLabsVoice}" exists in the ${avatar.voice_owner === 'byok' ? "user's connected" : 'shared'} ElevenLabs workspace.`,
        })
      }
    } else if (!resolvedAudioUrl) {
      // No ElevenLabs voice set — fall back to HeyGen TTS via voice_id.
      // The body-supplied voice_id wins iff it isn't an ElevenLabs ID
      // (which we already handled above).
      heygenVoiceId = (!explicitElevenLabs ? voice_id : '') || publicDefaultVoice || ''
      if (!heygenVoiceId) {
        return res.status(400).json({
          error: isPublic
            ? 'No default voice on this HeyGen avatar. Try a different one, set an ElevenLabs voice on the avatar, or wire in an audio file.'
            : 'No voice set on this avatar. Open the Avatars page and add an ElevenLabs voice, or wire an audio file into Avatar render.',
        })
      }
    }

    // Dispatch by engine. When we have audio_url (either supplied or
    // synthesized from ElevenLabs), HeyGen ignores voice_id entirely.
    let heygenVideoId
    try {
      if (modelDef.engine === 'v2_legacy') {
        const resp = await generateVideoV2({
          talkingPhotoId: avatarIdForApi,
          voiceId: heygenVoiceId,
          script,
          audioUrl: resolvedAudioUrl,
        })
        heygenVideoId = resp?.data?.video_id || resp?.video_id
      } else {
        const resp = await generateVideoV3({
          avatarId: avatarIdForApi,
          voiceId: heygenVoiceId,
          script,
          audioUrl: resolvedAudioUrl,
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

    // Persist render row. For public-library avatars we don't have an
    // internal avatar_id (it's "pub:..."), so we omit the FK and tag the
    // metadata instead. The status poller still works since heygen_video_id
    // is what it actually needs.
    const renderBody = {
      profile_id: avatar.profile_id,
      title: script.slice(0, 60),
      script,
      sentences: [],
      status: 'generating_clips',
      model_version: modelKey,
      // Persist whichever voice path was actually used so the renders
      // table reflects reality. ElevenLabs path → blank heygen voice +
      // audio_url stored on the row would be ideal; for now we record
      // the ElevenLabs voice id since that's the source of truth.
      voice_id: heygenVoiceId || elevenLabsVoice || '',
      heygen_video_id: heygenVideoId,
      video_units_charged: unitsToCharge,
      duration_secs: durationSecs,
    }
    if (!isPublic) renderBody.avatar_id = avatar_id
    const renderRow = await supaFetch('avatar_renders', { method: 'POST', body: renderBody })
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
