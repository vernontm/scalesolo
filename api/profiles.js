import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'
import { indexBrandBible } from './_lib/embeddings.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return
  const userId = auth.user.id

  try {
    if (req.method === 'GET') {
      const access = await supaFetch(
        `profile_access?user_id=eq.${userId}&select=role,allowed_pages,profile:profiles(*)`
      )
      const list = (access || []).map((row) => ({ ...(row.profile || {}), role: row.role, allowed_pages: row.allowed_pages }))
      return res.status(200).json({ profiles: list })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.business_name) return res.status(400).json({ error: 'business_name required' })
      const created = await supaFetch('profiles', {
        method: 'POST',
        body: {
          business_name: body.business_name,
          industry: body.industry || null,
          owner_name: body.owner_name || null,
          brand_primary_color: body.brand_primary_color || null,
          is_active: true,
        },
      })
      const profile = Array.isArray(created) ? created[0] : created
      await supaFetch('profile_access', {
        method: 'POST',
        body: {
          user_id: userId,
          profile_id: profile.id,
          role: 'owner',
          allowed_pages: ['*'],
        },
      })
      return res.status(201).json({ profile })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id || (req.body && req.body.id)
      if (!id) return res.status(400).json({ error: 'id required' })
      const role = await assertProfileAccess(userId, id)
      if (!['owner', 'admin'].includes(role)) return res.status(403).json({ error: 'Forbidden' })
      const updates = { ...(req.body || {}) }
      delete updates.id
      const brandBibleChanged = Object.prototype.hasOwnProperty.call(updates, 'brand_bible')
      const updated = await supaFetch(`profiles?id=eq.${id}`, {
        method: 'PATCH',
        body: updates,
      })
      const profile = Array.isArray(updated) ? updated[0] : updated
      // Re-embed brand bible chunks if it changed. Don't fail the save on
      // embedding errors — users can manually retrigger via /api/agent/index-brand-bible.
      if (brandBibleChanged) {
        indexBrandBible(id, profile?.brand_bible || '').catch((err) => {
          console.warn('[profiles] brand bible reindex failed:', err.message)
        })
      }
      return res.status(200).json({ profile })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const role = await assertProfileAccess(userId, id)
      if (role !== 'owner') return res.status(403).json({ error: 'Owner only' })
      await supaFetch(`profiles?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
