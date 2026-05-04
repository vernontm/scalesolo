// /api/landing-pages — CRUD for landing_pages.
import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'

const ALLOWED = new Set([
  'name','slug','custom_domain','sections','meta','is_published','ab_variant_of',
])

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
      if (id) {
        const rows = await supaFetch(`landing_pages?id=eq.${id}&select=*`)
        const page = rows?.[0]
        if (!page) return res.status(404).json({ error: 'Not found' })
        await assertProfileAccess(auth.user.id, page.profile_id)
        return res.status(200).json({ page })
      }
      const profileId = req.query.profile_id
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)
      const rows = await supaFetch(
        `landing_pages?profile_id=eq.${profileId}&order=updated_at.desc&select=id,name,slug,is_published,custom_domain,updated_at,created_at`
      )
      return res.status(200).json({ pages: rows || [] })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.profile_id || !body.name) return res.status(400).json({ error: 'profile_id + name required' })
      await assertProfileAccess(auth.user.id, body.profile_id)
      const slug = body.slug || slugify(body.name) || `page-${Date.now().toString(36)}`
      const created = await supaFetch('landing_pages', {
        method: 'POST',
        body: {
          profile_id: body.profile_id,
          name: body.name,
          slug,
          sections: body.sections || [],
          meta: body.meta || {},
          is_published: false,
        },
      })
      return res.status(201).json({ page: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id || (req.body && req.body.id)
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`landing_pages?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      const updates = {}
      for (const [k, v] of Object.entries(req.body || {})) if (ALLOWED.has(k)) updates[k] = v
      const updated = await supaFetch(`landing_pages?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ page: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`landing_pages?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      await supaFetch(`landing_pages?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
