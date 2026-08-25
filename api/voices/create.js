// /api/voices/create — Instant Voice Cloning.
//
// POST { profile_id, name, description?, sample_url, sample_urls? }
//
// If the brand has connected its OWN ElevenLabs key (BYOK), the voice is
// cloned into their workspace and voice_owner is 'byok' (resolves under
// their key at render time). If no BYOK key is connected, it falls back to
// the shared ScaleSolo ElevenLabs account (ELEVENLABS_API_KEY) and returns
// voice_owner 'shared' — so a brand can clone a voice without wiring up its
// own key. A shared voice resolves under our master key everywhere
// (preview + render), because those paths key off voice_owner.

import { setCors, requireUser, assertMinRole, supaFetch } from '../_lib/supabase.js'
import { decryptSecret } from '../_lib/crypto.js'

const MAX_SAMPLES = 5
const MAX_SAMPLE_BYTES = 25 * 1024 * 1024  // 25MB per sample

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, name, description, sample_url, sample_urls } = req.body || {}
    if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
    if (!name?.trim()) return res.status(400).json({ error: 'name required' })
    await assertMinRole(auth.user.id, profile_id, 'editor')

    // Resolve the ElevenLabs key. Prefer the brand's own BYOK key; if none is
    // connected, fall back to the shared ScaleSolo account so cloning still
    // works. voiceOwner tells the render/preview paths which key to use later.
    const profRows = await supaFetch(
      `profiles?id=eq.${profile_id}&select=elevenlabs_api_key_encrypted`
    )
    const enc = profRows?.[0]?.elevenlabs_api_key_encrypted
    let userApiKey
    let voiceOwner
    if (enc) {
      try { userApiKey = decryptSecret(enc) }
      catch {
        return res.status(500).json({ error: 'Could not decrypt your stored key. Disconnect and reconnect.' })
      }
      voiceOwner = 'byok'
    } else {
      userApiKey = process.env.ELEVENLABS_API_KEY
      voiceOwner = 'shared'
      if (!userApiKey) {
        return res.status(500).json({ error: 'Voice cloning is not configured.', code: 'no_elevenlabs_key' })
      }
    }

    const urls = Array.isArray(sample_urls) && sample_urls.length
      ? sample_urls.slice(0, MAX_SAMPLES)
      : (sample_url ? [sample_url] : [])
    if (!urls.length) return res.status(400).json({ error: 'sample_url or sample_urls required' })

    // Pull each sample into memory so we can multipart-upload to
    // ElevenLabs in one shot. This caps each sample at MAX_SAMPLE_BYTES
    // up front so a hostile / mistakenly-large URL doesn't blow the
    // serverless memory ceiling.
    const fd = new FormData()
    fd.append('name', String(name).trim().slice(0, 80))
    if (description) fd.append('description', String(description).trim().slice(0, 500))
    let i = 0
    for (const url of urls) {
      try {
        const r = await fetch(url)
        if (!r.ok) throw new Error(`fetch ${r.status}`)
        const ab = await r.arrayBuffer()
        if (ab.byteLength > MAX_SAMPLE_BYTES) {
          return res.status(413).json({ error: `Sample ${i + 1} too large (${ab.byteLength} bytes; max ${MAX_SAMPLE_BYTES}).` })
        }
        const ext = (url.split('?')[0].split('.').pop() || 'mp3').toLowerCase()
        const type = r.headers.get('content-type') || (ext === 'wav' ? 'audio/wav' : 'audio/mpeg')
        const blob = new Blob([ab], { type })
        fd.append('files', blob, `sample-${i + 1}.${ext}`)
      } catch (e) {
        return res.status(400).json({ error: `Could not download sample ${i + 1}: ${e.message}` })
      }
      i += 1
    }

    const r = await fetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: { 'xi-api-key': userApiKey },  // BYOK key or the shared ScaleSolo key
      body: fd,
    })
    const text = await r.text()
    let body = null
    try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
    if (!r.ok) {
      return res.status(502).json({ error: body?.detail?.message || body?.detail || `ElevenLabs ${r.status}`, raw: body })
    }
    return res.status(200).json({
      voice_id: body.voice_id,
      name: name.trim(),
      voice_owner: voiceOwner,  // 'byok' or 'shared' — caller stores it on the avatar row
    })
  } catch (err) {
    console.error('voices/create error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
