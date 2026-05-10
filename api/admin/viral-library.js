// /api/admin/viral-library — CRUD for the global viral-script library.
// Admin-only. Used as universal few-shot examples for new profiles
// + as inspiration for the auto-improvement cron later.

import { setCors, requireAdmin, supaFetch, isUuid } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireAdmin(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const niche = req.query.niche || null
      const filters = ['select=*', 'order=created_at.desc', 'limit=500']
      if (niche) filters.push(`niche=eq.${encodeURIComponent(niche)}`)
      const rows = await supaFetch(`viral_library?${filters.join('&')}`)
      return res.status(200).json({ items: rows || [] })
    }

    if (req.method === 'POST') {
      const { text, hook, format, niche, source_url, notes, active } = req.body || {}
      if (!text?.trim()) return res.status(400).json({ error: 'text required' })
      const inserted = await supaFetch('viral_library', {
        method: 'POST',
        body: [{
          text: String(text).slice(0, 8000),
          hook: hook ? String(hook).slice(0, 300) : null,
          format: format ? String(format).slice(0, 40) : null,
          niche: niche ? String(niche).slice(0, 60) : null,
          source_url: source_url ? String(source_url).slice(0, 500) : null,
          notes: notes ? String(notes).slice(0, 500) : null,
          active: active !== false,
          added_by: auth.user.id,
        }],
      })
      return res.status(201).json({ item: Array.isArray(inserted) ? inserted[0] : inserted })
    }

    if (req.method === 'PATCH') {
      const id = req.query.id
      if (!id || !isUuid(id)) return res.status(400).json({ error: 'id required (uuid)' })
      const ALLOWED = new Set(['text', 'hook', 'format', 'niche', 'source_url', 'notes', 'active'])
      const updates = {}
      for (const [k, v] of Object.entries(req.body || {})) {
        if (!ALLOWED.has(k)) continue
        updates[k] = k === 'active' ? !!v : (v == null ? null : String(v).slice(0, k === 'text' ? 8000 : 500))
      }
      const updated = await supaFetch(`viral_library?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ item: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id || !isUuid(id)) return res.status(400).json({ error: 'id required (uuid)' })
      await supaFetch(`viral_library?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
