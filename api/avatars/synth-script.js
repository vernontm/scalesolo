// POST /api/avatars/synth-script
// Body: { profile_id, avatar_id, script, voice_settings?, voice_model_id?, voice_language? }
// Returns: { audio_url, voice_used, chars }
//
// Synth-only path for the avatar render's audio-review flow. Resolves
// the avatar's stored ElevenLabs voice (or BYOK key), synthesizes the
// full script, uploads to Supabase Storage, and returns the public URL.
// No HeyGen submit. The Spaces avatar_render node calls this when its
// audio_review toggle is on; the user reviews + tweaks + approves, then
// the existing /api/avatars/photo-render endpoint kicks off HeyGen with
// audio_url already in hand (no re-synth).
//
// Per-render overrides (voice_settings / voice_model_id / voice_language)
// let the user tune the voice for THIS take without modifying the
// avatar's stored defaults — once they're happy, they approve and
// HeyGen lip-syncs to that exact audio.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import {
  synthesizeToPublicUrl, looksLikeElevenLabsVoiceId, resolveByoApiKey,
  sanitizeVoiceSettings, chargeTtsCredits,
} from '../_lib/elevenlabs.js'

// Vercel's default function timeout is 10s, but ElevenLabs Multilingual
// v2 / v3 on longer scripts can reasonably take 30-90s end-to-end
// (synth + Storage upload). 180s gives plenty of headroom for the case
// where script_gen overshoots the requested length and produces a
// ~90-120s read — used to time out at the old 60s cap and leave the
// voice_gen step hanging. ElevenLabs' own per-request char limit is
// the real ceiling (sanitized + capped client-side), this just stops
// us giving up on synths that ARE making progress.
export const config = { maxDuration: 180 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const {
      profile_id, avatar_id, voice_id, voice_owner, script,
      voice_settings, voice_model_id, voice_language,
    } = req.body || {}

    if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
    // Standalone voiceover mode: caller can supply voice_id directly
    // (no avatar required). Lets the voice_gen node work on its own as
    // part of a script → voiceover → polish flow that doesn't involve
    // a HeyGen avatar render.
    if (!avatar_id && !voice_id) {
      return res.status(400).json({ error: 'avatar_id OR voice_id required' })
    }
    if (!script || !String(script).trim()) return res.status(400).json({ error: 'script required' })
    await assertProfileAccess(auth.user.id, profile_id)

    let avatar = null
    let elevenLabsVoice = null
    let voiceOwner = (voice_owner || 'shared').trim()

    if (avatar_id) {
      // Avatar mode: pull the avatar so we know its voice + owner. Per-
      // render overrides win over the stored defaults so the user can
      // experiment with settings without saving them to the avatar.
      const aRows = await supaFetch(
        `avatars?id=eq.${encodeURIComponent(avatar_id)}` +
        '&select=id,profile_id,elevenlabs_voice_id,voice_owner,voice_settings,voice_model_id,voice_language'
      )
      avatar = aRows?.[0]
      if (!avatar) return res.status(404).json({ error: 'Avatar not found' })
      if (avatar.profile_id !== profile_id) return res.status(403).json({ error: 'Avatar does not belong to this profile' })
      elevenLabsVoice = avatar.elevenlabs_voice_id
      voiceOwner = avatar.voice_owner || 'shared'
      if (!elevenLabsVoice || !looksLikeElevenLabsVoiceId(elevenLabsVoice)) {
        return res.status(400).json({
          error: 'This avatar has no ElevenLabs voice set. Pick a voice on the Avatar page first.',
        })
      }
    } else {
      // Standalone voice mode: caller-provided voice_id only.
      elevenLabsVoice = String(voice_id).trim()
      if (!looksLikeElevenLabsVoiceId(elevenLabsVoice)) {
        return res.status(400).json({ error: 'voice_id is not a valid ElevenLabs voice id' })
      }
    }

    // Build synth options. Override layer wins over stored avatar values.
    // sanitizeVoiceSettings clamps every field to ElevenLabs' supported
    // ranges so a stale jsonb or bad client can't blow up the synth.
    const opts = {}
    if (voiceOwner === 'byok') {
      const apiKey = await resolveByoApiKey(profile_id)
      if (!apiKey) {
        return res.status(401).json({
          error: "This voice belongs to your ElevenLabs workspace, but the API key isn't connected.",
        })
      }
      opts.apiKey = apiKey
    }
    const settingsForSynth = sanitizeVoiceSettings(voice_settings) || sanitizeVoiceSettings(avatar?.voice_settings)
    if (settingsForSynth) opts.voice_settings = settingsForSynth
    const modelIdForSynth = (voice_model_id || avatar?.voice_model_id || '').trim()
    if (modelIdForSynth) opts.model_id = modelIdForSynth
    const languageForSynth = (voice_language || avatar?.voice_language || 'en').trim()
    if (languageForSynth) opts.language_code = languageForSynth

    // Synthesize.
    let audioUrl
    try {
      audioUrl = await synthesizeToPublicUrl(elevenLabsVoice, String(script), profile_id, opts)
    } catch (e) {
      return res.status(502).json({
        error: `ElevenLabs TTS failed: ${e.message}. Check that voice "${elevenLabsVoice}" exists in the ${avatar.voice_owner === 'byok' ? "user's connected" : 'shared'} workspace.`,
      })
    }

    // Charge tokens scaled by model — same path the full render uses,
    // so credits roll up consistently in admin/usage no matter which
    // mode the user is in.
    await chargeTtsCredits({
      userId: auth.user.id,
      profileId: profile_id,
      modelId: modelIdForSynth,
      charCount: String(script).length,
      refTable: avatar ? 'avatars' : 'voice_gen',
      refId:   avatar?.id || null,
      kind: 'review-synth',
    })

    return res.status(200).json({
      audio_url: audioUrl,
      voice_used: {
        voice_id: elevenLabsVoice,
        owner: voiceOwner,
        model_id: modelIdForSynth || null,
        language_code: languageForSynth || null,
        voice_settings: settingsForSynth || null,
      },
      chars: String(script).length,
    })
  } catch (err) {
    console.error('synth-script error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
