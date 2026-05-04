// Pipelines CRUD. Default pipeline is auto-created on first GET if none exists.
import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'

const DEFAULT_STAGES = ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost']

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
      let rows = await supaFetch(`pipelines?profile_id=eq.${profileId}&order=sort_order.asc&select=*`)
      if (!rows || rows.length === 0) {
        // Auto-create the default pipeline so the kanban isn't empty.
        const created = await supaFetch('pipelines', {
          method: 'POST',
          body: { profile_id: profileId, name: 'Sales', stages: DEFAULT_STAGES, is_default: true },
        })
        rows = Array.isArray(created) ? created : [created]
      }
      return res.status(200).json({ pipelines: rows })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.profile_id || !body.name) return res.status(400).json({ error: 'profile_id + name required' })
      await assertProfileAccess(auth.user.id, body.profile_id)
      const created = await supaFetch('pipelines', {
        method: 'POST',
        body: {
          profile_id: body.profile_id,
          name: body.name,
          stages: body.stages || DEFAULT_STAGES,
          is_default: !!body.is_default,
        },
      })
      return res.status(201).json({ pipeline: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id || (req.body && req.body.id)
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`pipelines?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      const updates = { ...(req.body || {}) }
      delete updates.id
      const updated = await supaFetch(`pipelines?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ pipeline: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`pipelines?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      await supaFetch(`pipelines?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
