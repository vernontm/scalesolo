// ElevenLabs Text-to-Speech helper. Used by avatar render when the avatar
// has elevenlabs_voice_id set — we synthesize the script via ElevenLabs,
// upload the resulting MP3 to Supabase storage, and pass the public URL to
// HeyGen as audio_url. HeyGen then lip-syncs to our audio instead of using
// its own TTS (which doesn't accept ElevenLabs voice IDs).

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const TTS_BUCKET = 'landing-media'  // existing public bucket already used by image_mirror

// Per-model TTS charging. ElevenLabs prices Turbo, Multilingual v2,
// and v3 at very different rates per character — the token cost we
// debit from the user's ai_tokens pool needs to mirror that ratio so
// margin stays consistent regardless of which model the user picks.
//
// Calibrated against ElevenLabs Studio per-1k-char retail at our
// $10/100K-token internal price ($0.0001/token). Turbo retail is the
// cheapest (~$0.10 / 1k chars) so we charge ~1 token/char as the
// baseline; Multilingual is ~3x; v3 is the most expressive and lands
// at ~5x baseline.
//
// To change pricing, edit this map; everything downstream picks it up.
export const TTS_MODELS = {
  eleven_turbo_v2_5:      { label: 'Turbo v2.5',      tokens_per_char: 1, supports_tags: false },
  eleven_multilingual_v2: { label: 'Multilingual v2', tokens_per_char: 3, supports_tags: false },
  eleven_v3:              { label: 'v3',              tokens_per_char: 5, supports_tags: true  },
}
const DEFAULT_TTS_MODEL = 'eleven_turbo_v2_5'

export function ttsModelInfo(modelId) {
  return TTS_MODELS[modelId] || TTS_MODELS[DEFAULT_TTS_MODEL]
}

// Tokens to debit for a synth call. Caller passes the actual char
// count of what got synthesized so charges are tied to real usage,
// not pre-trim length. Floors at 1 so a successful synth always
// records *something* in the ledger.
export function tokensForTts(modelId, charCount) {
  const m = ttsModelInfo(modelId)
  const chars = Math.max(0, Number(charCount) || 0)
  return Math.max(1, Math.ceil(chars * m.tokens_per_char))
}

// Best-effort consume after a successful synth. Skipped (no charge)
// when userId is missing or the user has no billing_customer row,
// matching the rest of our credit pattern. Logs and swallows on
// failure so a billing hiccup never breaks a render — the consume
// row is the source of truth for what got charged, missing rows
// surface in admin usage as $0 and we follow up.
export async function chargeTtsCredits({ userId, profileId, modelId, charCount, refTable = null, refId = null, kind = 'render' }) {
  if (!userId) return { skipped: 'no-user' }
  try {
    const { supaFetch } = await import('./supabase.js')
    const cust = await supaFetch(`billing_customers?user_id=eq.${userId}&select=id`).catch(() => [])
    const customerId = cust?.[0]?.id
    if (!customerId) return { skipped: 'no-customer' }
    const tokens = tokensForTts(modelId, charCount)
    const result = await supaFetch('rpc/consume_credits', {
      method: 'POST',
      body: {
        p_customer_id: customerId,
        p_pool_type: 'ai_tokens',
        p_amount: tokens,
        p_action: 'consume:tts-synthesis',
        p_ref_table: refTable,
        p_ref_id: refId,
        p_profile_id: profileId || null,
        p_metadata: {
          model: modelId || DEFAULT_TTS_MODEL,
          chars: Math.max(0, Number(charCount) || 0),
          kind,                    // 'render' | 'preview' | 'photo-render'
        },
      },
    })
    return { tokens, result }
  } catch (e) {
    console.warn('chargeTtsCredits failed:', e?.message || e)
    return { error: e?.message || String(e) }
  }
}

// Clamp a voice_settings payload to the ranges ElevenLabs accepts so a
// bad client (or a stale jsonb cell) can't push the synth into an
// unsupported state. Drops unknown keys. Returns null when input is
// not an object so callers can short-circuit.
const VS_RANGES = {
  stability:        [0, 1],
  similarity_boost: [0, 1],
  style:            [0, 1],
  speed:            [0.7, 1.2],   // ElevenLabs Turbo v2.5 / v3 supported range
}
export function sanitizeVoiceSettings(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  for (const [k, [lo, hi]] of Object.entries(VS_RANGES)) {
    const v = Number(raw[k])
    if (Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v))
  }
  if (typeof raw.use_speaker_boost === 'boolean') out.use_speaker_boost = raw.use_speaker_boost
  return Object.keys(out).length ? out : null
}

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
