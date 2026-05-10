// /api/brand-hooks — CRUD for the per-profile hooks library.
// Same shape as brand-scripts but smaller (just opener phrases).

import { setCors, requireUser, supaFetch, assertProfileAccess, isUuid } from './_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const profile_id = req.query.profile_id
      if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profile_id)
      const rows = await supaFetch(
        `brand_hooks?profile_id=eq.${profile_id}&select=*&order=rating.desc,created_at.desc&limit=200`
      )
      return res.status(200).json({ hooks: rows || [] })
    }

    if (req.method === 'POST') {
      const { profile_id, hook, rating, source } = req.body || {}
      if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
      if (!hook?.trim()) return res.status(400).json({ error: 'hook required' })
      await assertProfileAccess(auth.user.id, profile_id)
      const inserted = await supaFetch('brand_hooks', {
        method: 'POST',
        body: [{
          profile_id,
          hook: String(hook).slice(0, 500),
          rating: rating === -1 || rating === 1 ? rating : 0,
          source: source || 'user',
        }],
      })
      return res.status(201).json({ hook: Array.isArray(inserted) ? inserted[0] : inserted })
    }

    if (req.method === 'PATCH') {
      const id = req.query.id
      if (!id || !isUuid(id)) return res.status(400).json({ error: 'id required (uuid)' })
      const rows = await supaFetch(`brand_hooks?id=eq.${id}&select=profile_id`)
      const row = rows?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, row.profile_id)
      const ALLOWED = new Set(['hook', 'rating'])
      const updates = {}
      for (const [k, v] of Object.entries(req.body || {})) {
        if (!ALLOWED.has(k)) continue
        if (k === 'rating') updates[k] = (v === -1 || v === 1) ? v : 0
        else updates[k] = String(v || '').slice(0, 500)
      }
      const updated = await supaFetch(`brand_hooks?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ hook: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id || !isUuid(id)) return res.status(400).json({ error: 'id required (uuid)' })
      const rows = await supaFetch(`brand_hooks?id=eq.${id}&select=profile_id`)
      const row = rows?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, row.profile_id)
      await supaFetch(`brand_hooks?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
