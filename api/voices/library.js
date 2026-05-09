// /api/voices/library — voice list for the avatar voice picker.
//
//   GET                          → { shared: [...] }
//      Default mode. Returns ONLY ElevenLabs premade + professional
//      library voices keyed against our master ELEVENLABS_API_KEY.
//      Voices we (the operator) have cloned in our own workspace are
//      DELIBERATELY EXCLUDED so users never see / pick our private
//      custom voices.
//
//   GET ?byo=1&profile_id=…      → { byok: [...] }
//      Uses the brand profile's connected ElevenLabs key (BYOK) to
//      list voices in their own ElevenLabs workspace. 401 if they
//      haven't connected yet.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { decryptSecret } from '../_lib/crypto.js'

const MASTER_KEY = process.env.ELEVENLABS_API_KEY

async function listVoicesWithKey(apiKey) {
  const r = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': apiKey },
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    const err = new Error(`ElevenLabs ${r.status}: ${t.slice(0, 300)}`)
    err.status = r.status
    throw err
  }
  const body = await r.json()
  const voices = Array.isArray(body?.voices) ? body.voices : []
  return voices.map((v) => ({
    voice_id:    v.voice_id,
    name:        v.name,
    category:    v.category,
    description: v.description || (v.labels?.description) || '',
    preview_url: v.preview_url || null,
    labels:      v.labels || {},
  }))
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    // BYOK mode — pulls the user's own voices using their connected key.
    if (req.query.byo === '1') {
      const profileId = req.query.profile_id
      if (!profileId) return res.status(400).json({ error: 'profile_id required for BYOK mode' })
      await assertProfileAccess(auth.user.id, profileId)
      const rows = await supaFetch(
        `profiles?id=eq.${profileId}&select=elevenlabs_api_key_encrypted`
      )
      const enc = rows?.[0]?.elevenlabs_api_key_encrypted
      if (!enc) {
        return res.status(401).json({ error: 'Not connected', code: 'byok_not_connected' })
      }
      let key
      try { key = decryptSecret(enc) }
      catch (e) {
        return res.status(500).json({ error: 'Could not decrypt stored key. Reconnect.' })
      }
      const all = await listVoicesWithKey(key)
      // Show ALL of the user's voices in their account — premade,
      // professional, and cloned. They're paying for them, they should
      // see all of them.
      return res.status(200).json({ byok: all })
    }

    // Default: shared library, only premade + professional. Filter
    // out 'cloned' / 'generated' so our private custom voices stay
    // hidden.
    if (!MASTER_KEY) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' })
    const all = await listVoicesWithKey(MASTER_KEY)
    const shared = all.filter((v) => v.category === 'premade' || v.category === 'professional')
    return res.status(200).json({ shared })
  } catch (err) {
    console.error('voices/library error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
