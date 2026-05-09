// /api/voices/byok — manage the user's BYO ElevenLabs API key per brand
// profile.
//
//   GET  ?profile_id=…         → { connected, last4, connected_at }
//   POST ?action=connect       → body { profile_id, api_key }
//                                 verifies the key against /v1/user,
//                                 encrypts + stores. returns status.
//   POST ?action=disconnect    → body { profile_id }
//                                 wipes the encrypted blob + last4.
//
// The actual key never round-trips back to the SPA after connect —
// only the last 4 chars + connected timestamp.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { encryptSecret, maskSecretLast4 } from '../_lib/crypto.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const profileId = req.query.profile_id
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)
      const rows = await supaFetch(
        `profiles?id=eq.${profileId}&select=elevenlabs_api_key_last4,elevenlabs_connected_at,elevenlabs_api_key_encrypted`
      )
      const row = rows?.[0]
      return res.status(200).json({
        connected: !!row?.elevenlabs_api_key_encrypted,
        last4: row?.elevenlabs_api_key_last4 || null,
        connected_at: row?.elevenlabs_connected_at || null,
      })
    }

    if (req.method === 'POST') {
      const action = req.query.action
      const { profile_id, api_key } = req.body || {}
      if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profile_id)

      if (action === 'connect') {
        const trimmed = String(api_key || '').trim()
        if (trimmed.length < 16 || trimmed.length > 200) {
          return res.status(400).json({ error: 'api_key required' })
        }
        // Verify by calling ElevenLabs with the user's key.
        const r = await fetch('https://api.elevenlabs.io/v1/user', {
          headers: { 'xi-api-key': trimmed },
        })
        if (!r.ok) {
          const t = await r.text().catch(() => '')
          return res.status(401).json({ error: `ElevenLabs rejected the key (${r.status}). ${t.slice(0, 200)}` })
        }
        const enc = encryptSecret(trimmed)
        await supaFetch(`profiles?id=eq.${profile_id}`, {
          method: 'PATCH',
          body: {
            elevenlabs_api_key_encrypted: enc,
            elevenlabs_api_key_last4: maskSecretLast4(trimmed),
            elevenlabs_connected_at: new Date().toISOString(),
          },
          prefer: 'return=minimal',
        })
        return res.status(200).json({
          connected: true,
          last4: maskSecretLast4(trimmed),
          connected_at: new Date().toISOString(),
        })
      }

      if (action === 'disconnect') {
        await supaFetch(`profiles?id=eq.${profile_id}`, {
          method: 'PATCH',
          body: {
            elevenlabs_api_key_encrypted: null,
            elevenlabs_api_key_last4: null,
            elevenlabs_connected_at: null,
          },
          prefer: 'return=minimal',
        })
        return res.status(200).json({ connected: false })
      }

      return res.status(400).json({ error: `unknown action: ${action}` })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('voices/byok error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
