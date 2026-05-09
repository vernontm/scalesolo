// ElevenLabs Text-to-Speech helper. Used by avatar render when the avatar
// has elevenlabs_voice_id set — we synthesize the script via ElevenLabs,
// upload the resulting MP3 to Supabase storage, and pass the public URL to
// HeyGen as audio_url. HeyGen then lip-syncs to our audio instead of using
// its own TTS (which doesn't accept ElevenLabs voice IDs).

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const TTS_BUCKET = 'landing-media'  // existing public bucket already used by image_mirror

// ElevenLabs voice IDs are 20-char alphanumeric (mixed case, no dashes).
// HeyGen voice IDs are typically 32-char lowercase hex. This is a fast
// heuristic for callers that have a single voice_id field but need to
// route it correctly. Don't use for security-critical decisions; the
// authoritative signal is which DB column the value came from.
export function looksLikeElevenLabsVoiceId(s) {
  if (!s || typeof s !== 'string') return false
  // 20 chars, mixed case alphanumeric, no separators.
  return /^[A-Za-z0-9]{18,24}$/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s)
}

// Synthesize `text` to MP3 using ElevenLabs voice `voiceId`. Returns the raw
// audio Buffer. Throws on any non-200 response.
//
// `opts.apiKey` overrides our master ELEVENLABS_API_KEY when provided —
// used for BYOK voices that live in the user's own workspace and only
// resolve under their key. Caller passes this through after looking up
// avatars.voice_owner.
export async function synthesizeMp3(voiceId, text, opts = {}) {
  const apiKey = opts.apiKey || ELEVENLABS_API_KEY
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured')
  if (!voiceId) throw new Error('voiceId required')
  if (!text) throw new Error('text required')
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: opts.model_id || 'eleven_turbo_v2_5',
      voice_settings: opts.voice_settings || {
        stability: 0.5,
        similarity_boost: 0.85,
        style: 0.2,
        use_speaker_boost: true,
      },
    }),
  })
  if (!r.ok) {
    let detail = ''
    try { detail = (await r.text())?.slice(0, 500) } catch {}
    throw new Error(`ElevenLabs ${r.status}${detail ? `: ${detail}` : ''}`)
  }
  const buf = Buffer.from(await r.arrayBuffer())
  return buf
}

// Look up the user's BYOK ElevenLabs key for a profile. Returns null
// when the profile hasn't connected one. Best-effort — never throws,
// the caller treats null as "fall through to master key."
export async function resolveByoApiKey(profileId) {
  if (!profileId) return null
  try {
    const { supaFetch } = await import('./supabase.js')
    const { decryptSecret } = await import('./crypto.js')
    const rows = await supaFetch(
      `profiles?id=eq.${profileId}&select=elevenlabs_api_key_encrypted`
    )
    const enc = rows?.[0]?.elevenlabs_api_key_encrypted
    if (!enc) return null
    return decryptSecret(enc)
  } catch (e) {
    console.warn('resolveByoApiKey failed:', e?.message || e)
    return null
  }
}

// Synthesize and upload to Supabase storage. Returns a CORS-friendly public
// URL suitable for HeyGen's audio_url. Throws on any failure.
export async function synthesizeToPublicUrl(voiceId, text, profileId, opts = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Supabase storage not configured')
  const buf = await synthesizeMp3(voiceId, text, opts)
  const path = `${profileId || 'shared'}/tts/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`
  const upload = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${TTS_BUCKET}/${encodeURI(path)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'audio/mpeg',
        'x-upsert': 'true',
      },
      body: buf,
    }
  )
  if (!upload.ok) {
    let detail = ''
    try { detail = (await upload.text())?.slice(0, 500) } catch {}
    throw new Error(`TTS upload failed (${upload.status})${detail ? `: ${detail}` : ''}`)
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${TTS_BUCKET}/${path}`
}
