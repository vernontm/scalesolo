// /api/spaces — CRUD for content-workflow canvases.
import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'

const ALLOWED = new Set(['name','description','nodes','edges','last_run'])

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const id = req.query.id
      if (id) {
        const rows = await supaFetch(`spaces?id=eq.${id}&select=*`)
        const space = rows?.[0]
        if (!space) return res.status(404).json({ error: 'Not found' })
        await assertProfileAccess(auth.user.id, space.profile_id)
        return res.status(200).json({ space })
      }
      const profileId = req.query.profile_id
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)
      const rows = await supaFetch(
        `spaces?profile_id=eq.${profileId}&order=updated_at.desc&select=id,name,description,updated_at,created_at`
      )
      return res.status(200).json({ spaces: rows || [] })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.profile_id) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, body.profile_id)
      const created = await supaFetch('spaces', {
        method: 'POST',
        body: {
          profile_id: body.profile_id,
          name: body.name || 'Untitled space',
          description: body.description || null,
          nodes: body.nodes || [],
          edges: body.edges || [],
        },
      })
      return res.status(201).json({ space: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id || (req.body && req.body.id)
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`spaces?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      const updates = {}
      for (const [k, v] of Object.entries(req.body || {})) if (ALLOWED.has(k)) updates[k] = v
      const updated = await supaFetch(`spaces?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ space: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`spaces?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      await supaFetch(`spaces?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
