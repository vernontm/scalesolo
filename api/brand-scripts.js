// /api/brand-scripts — CRUD for the per-profile reference scripts
// library. Powers the Voice training section on the Profiles page;
// generation pulls liked rows as few-shot examples.

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
      const limit = Math.min(Number(req.query.limit) || 100, 500)
      const rows = await supaFetch(
        `brand_scripts?profile_id=eq.${profile_id}&select=*&order=rating.desc,created_at.desc&limit=${limit}`
      )
      return res.status(200).json({ scripts: rows || [] })
    }

    if (req.method === 'POST') {
      const { profile_id, text, hook, format, source, notes, rating } = req.body || {}
      if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
      if (!text?.trim()) return res.status(400).json({ error: 'text required' })
      await assertProfileAccess(auth.user.id, profile_id)
      const inserted = await supaFetch('brand_scripts', {
        method: 'POST',
        body: [{
          profile_id,
          text: String(text).slice(0, 8000),
          hook: hook ? String(hook).slice(0, 300) : null,
          format: format ? String(format).slice(0, 40) : null,
          source: source || 'user_paste',
          notes: notes ? String(notes).slice(0, 500) : null,
          rating: rating === -1 || rating === 1 ? rating : 0,
        }],
      })
      return res.status(201).json({ script: Array.isArray(inserted) ? inserted[0] : inserted })
    }

    if (req.method === 'PATCH') {
      const id = req.query.id
      if (!id || !isUuid(id)) return res.status(400).json({ error: 'id required (uuid)' })
      // Look up the row to verify access via its profile_id.
      const rows = await supaFetch(`brand_scripts?id=eq.${id}&select=profile_id`)
      const row = rows?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, row.profile_id)

      const ALLOWED = new Set(['text', 'hook', 'format', 'notes', 'rating'])
      const updates = { updated_at: new Date().toISOString() }
      for (const [k, v] of Object.entries(req.body || {})) {
        if (!ALLOWED.has(k)) continue
        if (k === 'rating') updates[k] = (v === -1 || v === 1) ? v : 0
        else updates[k] = v == null ? null : String(v).slice(0, k === 'text' ? 8000 : 500)
      }
      const updated = await supaFetch(`brand_scripts?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ script: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id || !isUuid(id)) return res.status(400).json({ error: 'id required (uuid)' })
      const rows = await supaFetch(`brand_scripts?id=eq.${id}&select=profile_id`)
      const row = rows?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, row.profile_id)
      await supaFetch(`brand_scripts?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
