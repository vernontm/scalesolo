// /api/agent/pinned-facts
//   GET    ?profile_id=...                                  → list
//   POST   { profile_id, fact, source?, source_ref? }       → create
//   DELETE ?id=...                                          → delete

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
        `agent_pinned_facts?profile_id=eq.${profileId}&order=created_at.desc&select=*`
      )
      return res.status(200).json({ facts: rows || [] })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.profile_id || !body.fact?.trim()) {
        return res.status(400).json({ error: 'profile_id and fact required' })
      }
      await assertProfileAccess(auth.user.id, body.profile_id)
      const created = await supaFetch('agent_pinned_facts', {
        method: 'POST',
        body: {
          profile_id: body.profile_id,
          fact: body.fact.trim(),
          source: body.source || 'manual',
          source_ref: body.source_ref || null,
        },
      })
      return res.status(201).json({ fact: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`agent_pinned_facts?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      await supaFetch(`agent_pinned_facts?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
