// POST /api/avatars/default-voice
// Body: { default_avatar_id, elevenlabs_voice_id, voice_label? }
//   → Upsert the user's voice override for this default avatar.
//
// DELETE /api/avatars/default-voice?id=<default_avatar_id>
//   → Remove the override (avatar reverts to its admin-set default voice).
//
// Auth required. RLS on default_avatar_voice_overrides already
// scopes rows to the row's user_id, so the user can only ever
// read/write their own.

import { setCors, requireUser, supaFetch } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'POST') {
      const { default_avatar_id, elevenlabs_voice_id, voice_label } = req.body || {}
      if (!default_avatar_id) return res.status(400).json({ error: 'default_avatar_id required' })
      if (!elevenlabs_voice_id) return res.status(400).json({ error: 'elevenlabs_voice_id required' })
      // Upsert. PostgREST does this via Prefer: resolution=merge-duplicates
      // when the on-conflict is the composite primary key (user_id +
      // default_avatar_id).
      await supaFetch('default_avatar_voice_overrides', {
        method: 'POST',
        body: {
          user_id: auth.user.id,
          default_avatar_id,
          elevenlabs_voice_id,
          voice_label: voice_label || null,
          updated_at: new Date().toISOString(),
        },
        prefer: 'resolution=merge-duplicates,return=minimal',
      })
      return res.status(200).json({ ok: true })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      await supaFetch(
        `default_avatar_voice_overrides?user_id=eq.${auth.user.id}&default_avatar_id=eq.${encodeURIComponent(id)}`,
        { method: 'DELETE', prefer: 'return=minimal' },
      )
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
