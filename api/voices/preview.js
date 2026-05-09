// /api/voices/preview — short TTS preview for a voice ID.
// POST { voice_id, text? } → returns { audio_url } (signed-ish; actually
// a public URL because we drop the MP3 in landing-media).
//
// Used by the avatar voice picker so users can hear a ~5s sample of any
// voice (default library voice OR their own cloned voice OR a pasted
// 3rd-party voice_id) before assigning it to an avatar.

import { setCors, requireUser, assertProfileAccess } from '../_lib/supabase.js'
import { synthesizeToPublicUrl } from '../_lib/elevenlabs.js'

const DEFAULT_PREVIEW_TEXT =
  "Hi, I'm your ScaleSolo avatar voice. This is a quick preview of how I sound."

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { voice_id, profile_id, text } = req.body || {}
    if (!voice_id) return res.status(400).json({ error: 'voice_id required' })
    // profile_id is optional — preview works without one (admin / new
    // user) but if provided we verify access so a stranger can't
    // probe arbitrary profiles by id.
    if (profile_id) await assertProfileAccess(auth.user.id, profile_id)
    const sample = String(text || DEFAULT_PREVIEW_TEXT).slice(0, 200)
    const url = await synthesizeToPublicUrl(voice_id, sample, profile_id || 'previews')
    return res.status(200).json({ audio_url: url })
  } catch (err) {
    console.error('voices/preview error:', err?.stack || err)
    return res.status(err.status || 502).json({ error: String(err?.message || err) })
  }
}
