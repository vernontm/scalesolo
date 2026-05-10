// /api/voices/preview — short TTS preview for a voice ID.
// POST { voice_id, text? } → returns { audio_url } (signed-ish; actually
// a public URL because we drop the MP3 in landing-media).
//
// Used by the avatar voice picker so users can hear a ~5s sample of any
// voice (default library voice OR their own cloned voice OR a pasted
// 3rd-party voice_id) before assigning it to an avatar.

import { setCors, requireUser, assertProfileAccess } from '../_lib/supabase.js'
import { synthesizeToPublicUrl, resolveByoApiKey, sanitizeVoiceSettings } from '../_lib/elevenlabs.js'

const DEFAULT_PREVIEW_TEXT =
  "Hi, I'm your ScaleSolo avatar voice. This is a quick preview of how I sound."

// Per-user rate limit. Without it, a malicious authenticated user
// could script TTS calls against our shared ELEVENLABS_API_KEY (which
// is metered and costs us real money) at hundreds of requests / sec.
// 30 / minute matches the rough budget of a human exploring the
// picker — preview every voice in the library + retry a few times —
// without leaving room for scripted abuse.
const PREVIEW_LIMIT = 30
const PREVIEW_WINDOW_MS = 60_000
const _userBucket = new Map()

function previewRateLimitOk(userId) {
  if (!userId) return false
  const now = Date.now()
  const cur = _userBucket.get(userId)
  if (!cur || cur.resetAt < now) {
    _userBucket.set(userId, { count: 1, resetAt: now + PREVIEW_WINDOW_MS })
    if (_userBucket.size > 5000) {
      for (const [k, v] of _userBucket) if (v.resetAt < now) _userBucket.delete(k)
    }
    return true
  }
  cur.count += 1
  return cur.count <= PREVIEW_LIMIT
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  if (!previewRateLimitOk(auth.user.id)) {
    return res.status(429).json({ error: 'Too many previews. Try again in a minute.' })
  }

  try {
    const { voice_id, profile_id, text, byok, voice_settings, model_id } = req.body || {}
    if (!voice_id) return res.status(400).json({ error: 'voice_id required' })
    // profile_id is optional — preview works without one (admin / new
    // user) but if provided we verify access so a stranger can't
    // probe arbitrary profiles by id.
    if (profile_id) await assertProfileAccess(auth.user.id, profile_id)
    const sample = String(text || DEFAULT_PREVIEW_TEXT).slice(0, 300)
    // Build the synth options: BYOK key + the voice tuning the caller
    // sent. The voice picker just sends the basics; the avatar voice
    // settings panel sends a full voice_settings + model_id so users
    // can audition their tweaks before saving.
    const opts = {}
    if (byok && profile_id) {
      const apiKey = await resolveByoApiKey(profile_id)
      if (!apiKey) return res.status(401).json({ error: 'BYOK key not connected for this profile.', code: 'byok_not_connected' })
      opts.apiKey = apiKey
    }
    if (voice_settings && typeof voice_settings === 'object') {
      opts.voice_settings = sanitizeVoiceSettings(voice_settings)
    }
    if (typeof model_id === 'string' && model_id.trim()) {
      opts.model_id = model_id.trim()
    }
    const url = await synthesizeToPublicUrl(voice_id, sample, profile_id || 'previews', opts)
    return res.status(200).json({ audio_url: url })
  } catch (err) {
    console.error('voices/preview error:', err?.stack || err)
    return res.status(err.status || 502).json({ error: String(err?.message || err) })
  }
}
