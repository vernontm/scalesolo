// /api/agent/conversations
//   GET  ?profile_id=...           → list recent conversations for a profile
//   DELETE ?id=...                  → soft-delete (or hard-delete for now)
//
// /api/agent/conversations/<id>/messages — handled by ./conversations/[id]/messages.js
//   (kept simple for v1: this file handles list + delete only)

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

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
        `agent_conversations?profile_id=eq.${profileId}&is_archived=eq.false&order=updated_at.desc&limit=50&select=id,title,updated_at,created_at`
      )
      return res.status(200).json({ conversations: rows || [] })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      // Look up the conversation's profile_id, then assert access.
      const rows = await supaFetch(`agent_conversations?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      await supaFetch(`agent_conversations?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
