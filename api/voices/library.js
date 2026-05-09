// /api/voices/library — list ElevenLabs voices the user can pick from.
//
// GET → {
//   shared: [{ voice_id, name, category, description, preview_url, labels }],
//   cloned: [{ voice_id, name, category, description, preview_url, labels }],
// }
//
// "shared" = the public/library voices on the workspace (what ElevenLabs
// calls `category: 'premade'` plus any 'professional' voices). "cloned"
// = voices the user has uploaded via Instant Voice Cloning. Both come
// from the same /v1/voices endpoint; we split by `category` so the UI
// can render two distinct sections.

import { setCors, requireUser } from '../_lib/supabase.js'

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' })

  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      return res.status(502).json({ error: `ElevenLabs ${r.status}: ${t.slice(0, 300)}` })
    }
    const body = await r.json()
    const voices = Array.isArray(body?.voices) ? body.voices : []
    const slim = voices.map((v) => ({
      voice_id:    v.voice_id,
      name:        v.name,
      category:    v.category,         // 'premade' | 'professional' | 'cloned' | 'generated'
      description: v.description || (v.labels?.description) || '',
      preview_url: v.preview_url || null,
      labels:      v.labels || {},
    }))
    return res.status(200).json({
      shared: slim.filter((v) => v.category === 'premade' || v.category === 'professional'),
      cloned: slim.filter((v) => v.category === 'cloned' || v.category === 'generated'),
    })
  } catch (err) {
    console.error('voices/library error:', err?.stack || err)
    return res.status(500).json({ error: err.message })
  }
}
