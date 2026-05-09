// /api/voices/create — Instant Voice Cloning.
// POST { profile_id, name, description?, sample_url, sample_urls? }
//
// Pipes a hosted audio sample (one or more URLs) into ElevenLabs's
// /v1/voices/add multipart endpoint and returns the new voice_id. The
// caller then patches it onto an avatar via the existing /api/avatars
// PATCH path.
//
// We fetch the audio server-side so the browser never has to deal with
// a multipart upload to ElevenLabs (their API key would have to be
// exposed). Sample is expected to be a 30s-2min recording; ElevenLabs
// recommends ≥1 minute of clean speech.

import { setCors, requireUser, assertProfileAccess } from '../_lib/supabase.js'

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
const MAX_SAMPLES = 5
const MAX_SAMPLE_BYTES = 25 * 1024 * 1024  // 25MB per sample

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' })

  try {
    const { profile_id, name, description, sample_url, sample_urls } = req.body || {}
    if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
    if (!name?.trim()) return res.status(400).json({ error: 'name required' })
    await assertProfileAccess(auth.user.id, profile_id)

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
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },  // fetch sets multipart boundary
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
    })
  } catch (err) {
    console.error('voices/create error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
