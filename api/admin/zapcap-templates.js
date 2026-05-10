// /api/admin/zapcap-templates — admin-managed ZapCap caption template
// catalog. The picker shows each template using preview_gif_url here
// instead of ZapCap's branded demo footage; sync pulls fresh ids +
// titles from ZapCap so new templates appear in the admin list as
// soon as the team adds them upstream.
//
//   GET                                   → { templates }
//   POST  ?action=sync                    → upsert id+title from ZapCap
//   PATCH { template_id, ... }            → update preview_gif_url / sort_order / active / title
//   DELETE ?template_id=...               → remove a row
//
// Mutations require admin (requireAdmin). The picker reads through
// /api/zapcap/templates which merges this with the live ZapCap call.

import { setCors, requireAdmin, supaFetch } from '../_lib/supabase.js'
import { zapcapListTemplates } from '../_lib/zapcap.js'

const ALLOWED_PATCH = new Set(['title', 'preview_gif_url', 'sort_order', 'active'])

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireAdmin(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const rows = await supaFetch(
        'zapcap_template_previews?order=sort_order.asc,title.asc&select=*'
      )
      return res.status(200).json({ templates: rows || [] })
    }

    if (req.method === 'POST' && req.query.action === 'sync') {
      // Pull live catalog. Upsert each by template_id, preserving
      // preview_gif_url, sort_order, active — those are admin-curated.
      const live = await zapcapListTemplates()
      const list = Array.isArray(live) ? live : (Array.isArray(live?.templates) ? live.templates : [])
      let upserted = 0
      const seen = new Set()
      for (const t of list) {
        const id = t.id || t._id || t.templateId
        const title = t.name || t.label || t.title || (id ? `Template ${id.slice(0, 8)}` : null)
        if (!id || !title) continue
        seen.add(id)
        try {
          await supaFetch('zapcap_template_previews', {
            method: 'POST',
            // PostgREST upsert via prefer header. Conflict on PK
            // updates title + last_synced_at without touching the
            // admin-curated columns.
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: {
              template_id: id,
              title,
              last_synced_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          })
          upserted += 1
        } catch (e) {
          console.warn('zapcap-templates sync row failed', id, e?.message)
        }
      }
      return res.status(200).json({
        ok: true,
        upserted,
        live_total: list.length,
      })
    }

    if (req.method === 'PATCH') {
      const body = req.body || {}
      const id = body.template_id || req.query.template_id
      if (!id) return res.status(400).json({ error: 'template_id required' })
      const updates = { updated_at: new Date().toISOString() }
      for (const [k, v] of Object.entries(body)) {
        if (k === 'template_id') continue
        if (ALLOWED_PATCH.has(k)) updates[k] = v
      }
      const updated = await supaFetch(
        `zapcap_template_previews?template_id=eq.${encodeURIComponent(id)}`,
        { method: 'PATCH', body: updates }
      )
      return res.status(200).json({ template: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.template_id
      if (!id) return res.status(400).json({ error: 'template_id required' })
      await supaFetch(
        `zapcap_template_previews?template_id=eq.${encodeURIComponent(id)}`,
        { method: 'DELETE', prefer: 'return=minimal' }
      )
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('admin/zapcap-templates error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
