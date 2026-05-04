// Forms CRUD. Public submission endpoint is /api/forms/submit (separate file).
import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'

function slugify(s) {
  return (s || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const id = req.query.id
      const profileId = req.query.profile_id

      if (id) {
        const rows = await supaFetch(`forms?id=eq.${id}&select=*`)
        const form = rows?.[0]
        if (!form) return res.status(404).json({ error: 'Not found' })
        await assertProfileAccess(auth.user.id, form.profile_id)
        return res.status(200).json({ form })
      }

      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)
      const rows = await supaFetch(
        `forms?profile_id=eq.${profileId}&order=updated_at.desc&select=id,name,slug,is_published,created_at,updated_at`
      )
      return res.status(200).json({ forms: rows || [] })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.profile_id || !body.name) return res.status(400).json({ error: 'profile_id + name required' })
      await assertProfileAccess(auth.user.id, body.profile_id)
      const slug = body.slug || slugify(body.name) || `form-${Date.now()}`
      const created = await supaFetch('forms', {
        method: 'POST',
        body: {
          profile_id: body.profile_id,
          name: body.name,
          slug,
          layout: body.layout || 'standard',
          sections: body.sections || [],
          confirmation: body.confirmation || { kind: 'message', message: 'Thanks — we got it.' },
          is_published: false,
        },
      })
      return res.status(201).json({ form: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id || (req.body && req.body.id)
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`forms?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      const updates = { ...(req.body || {}) }
      delete updates.id
      delete updates.profile_id
      const updated = await supaFetch(`forms?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ form: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`forms?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      await supaFetch(`forms?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
