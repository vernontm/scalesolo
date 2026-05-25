// POST /api/studio/estimate-cost
//
// Returns the predicted spend for a Studio video across the three
// credit pools (ai_tokens, video_units, voice_minutes) + the user's
// current balance for each pool. The UI uses this to:
//   - show a "this video will cost ~X credits" preview before the
//     user kicks off generation
//   - block the generate / render buttons when the user is short
//
// Body (one of):
//   { studio_video_id: uuid }   — score an existing draft, uses real
//                                  segment counts + script length
//   { aspect_ratio, target_duration_secs, has_avatar }
//                                — score a planned video before the
//                                  draft is even created
//
// The estimator is intentionally rough — actual costs depend on
// segment-type distribution, avatar pacing, etc. Returns LOW and HIGH
// bounds. The gate uses HIGH so users don't get hit with mid-bake
// "insufficient credits" surprises.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { gateStudio } from './_lib/gate.js'
import { customerIdForUser } from '../_lib/credits.js'

// Per-pool cost coefficients. Calibrated against typical Studio runs:
//   - 90-second avatar video, 18-24 segments
//   - Sleek template with overlays + captions on
//   - One render + ~3 chat turns
const COSTS = {
  // ai_tokens — Claude tokens (input + output) per phase of the pipeline.
  // The big consumers are segmentation (one giant tool call) and the
  // two enrichment passes (overlays + motion graphics). Chat is a small
  // tail. Numbers are per-VIDEO not per-segment.
  ai_tokens: {
    segmentation:        { low: 12000, high: 20000 },
    enrich_overlays:     { low:  8000, high: 14000 },
    refresh_motion:      { low:  5000, high:  9000 },
    chat_per_turn:       { low:  1500, high:  3500 },
  },
  // video_units — HeyGen seconds. 1 unit ≈ 6.7s in our billing model.
  // Per avatar second of footage. Multiplied by total avatar duration.
  video_units_per_avatar_sec: 1 / 6.7,
  // voice_minutes — ElevenLabs synthesis. Every voiceover segment + every
  // avatar segment needs voice. Average across segment types.
  voice_minutes_per_voice_sec: 1 / 60,
}

// Compute predicted spend given the rough shape of a video.
function estimate({ duration_secs, has_avatar, segment_count, chat_turns = 3 }) {
  const ai = COSTS.ai_tokens
  const aiTokensLow =
    ai.segmentation.low +
    ai.enrich_overlays.low +
    ai.refresh_motion.low +
    chat_turns * ai.chat_per_turn.low
  const aiTokensHigh =
    ai.segmentation.high +
    ai.enrich_overlays.high +
    ai.refresh_motion.high +
    chat_turns * ai.chat_per_turn.high

  // Avatar duration: typically ~60-70% of total video runtime is spoken
  // (the rest is motion graphics + B-roll). When no avatar, it's 0.
  const avatarDurationSecs = has_avatar ? Math.round(duration_secs * 0.65) : 0
  const videoUnitsLow  = Math.ceil(avatarDurationSecs * 0.85 * COSTS.video_units_per_avatar_sec)
  const videoUnitsHigh = Math.ceil(avatarDurationSecs * 1.15 * COSTS.video_units_per_avatar_sec)

  // Voice covers every voiceover segment (avatar + voiceover_broll +
  // voiceover_motion_graphics). For a video with avatar, total voice
  // duration ≈ total runtime. For voiceover-only (no avatar), still
  // close to total runtime since the video is wall-to-wall voice.
  const voiceMinutesLow  = duration_secs * 0.90 * COSTS.voice_minutes_per_voice_sec
  const voiceMinutesHigh = duration_secs * 1.10 * COSTS.voice_minutes_per_voice_sec

  return {
    ai_tokens:     { low: aiTokensLow,  high: aiTokensHigh },
    video_units:   { low: videoUnitsLow, high: videoUnitsHigh },
    voice_minutes: { low: Number(voiceMinutesLow.toFixed(2)), high: Number(voiceMinutesHigh.toFixed(2)) },
  }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    gateStudio(auth.user.id)

    // Two shapes: existing-video or planned-video.
    const { studio_video_id, aspect_ratio, target_duration_secs, has_avatar, profile_id } = req.body || {}

    let duration_secs, hasAvatar, segment_count
    if (studio_video_id) {
      // Existing video — load real numbers.
      const vRows = await supaFetch(`studio_videos?id=eq.${studio_video_id}&select=*&limit=1`)
      const video = vRows?.[0]
      if (!video) return res.status(404).json({ error: 'Video not found' })
      await assertProfileAccess(auth.user.id, video.profile_id)

      duration_secs = Number(video.target_duration_secs) || 120
      hasAvatar = !!video.avatar_id
      const segs = await supaFetch(
        `studio_segments?studio_video_id=eq.${studio_video_id}&select=segment_type&limit=500`
      )
      segment_count = (segs || []).length || Math.round(duration_secs / 5)
    } else {
      // Pre-creation form — caller passes the rough shape.
      if (!profile_id) return res.status(400).json({ error: 'profile_id required when studio_video_id is not provided' })
      await assertProfileAccess(auth.user.id, profile_id)
      duration_secs = Number(target_duration_secs) || 120
      hasAvatar = !!has_avatar
      segment_count = Math.round(duration_secs / 5)
    }

    const cost = estimate({ duration_secs, has_avatar: hasAvatar, segment_count })

    // Current balance per pool. If the user has no billing customer yet
    // (free trial / never subscribed), default to zero balances.
    const customerId = await customerIdForUser(auth.user.id)
    let balance = { ai_tokens: 0, video_units: 0, voice_minutes: 0 }
    if (customerId) {
      const pools = await supaFetch(
        `credit_pools?customer_id=eq.${customerId}&select=pool_type,balance`,
      )
      for (const p of (pools || [])) {
        if (p.pool_type in balance) balance[p.pool_type] = Number(p.balance) || 0
      }
    }

    // Decide whether the user can afford the HIGH bound. UI uses this
    // to enable / disable the render button.
    const sufficient = {
      ai_tokens:     balance.ai_tokens     >= cost.ai_tokens.high,
      video_units:   balance.video_units   >= cost.video_units.high,
      voice_minutes: balance.voice_minutes >= cost.voice_minutes.high,
    }
    const can_render = sufficient.ai_tokens && sufficient.video_units && sufficient.voice_minutes

    return res.status(200).json({
      cost,
      balance,
      sufficient,
      can_render,
      assumptions: {
        duration_secs,
        has_avatar: hasAvatar,
        segment_count,
        avatar_duration_secs: hasAvatar ? Math.round(duration_secs * 0.65) : 0,
      },
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || String(err) })
  }
}
