// /api/admin/templates  — admin-only CRUD for global Spaces templates.
//
//   GET  /api/admin/templates                  → list every template (public + private)
//   POST /api/admin/templates                  → create-from-space body { source_id, name?, summary?, gate?, plan_gate?, sort_order? }
//                                                 OR  promote-existing-template body { template_id, gate?, plan_gate?, sort_order? }
//   PATCH /api/admin/templates?id=...          → update metadata + gating on a single template
//   DELETE /api/admin/templates?id=...         → delete template
//
// Templates live in public.spaces with is_template=true. Visibility:
//   • template_visibility='private' — owner-only (created by save_as_template)
//   • template_visibility='public'  — visible to every user, gated by template_plan_gate
// Plan gate is text[] of tier keys (solo_starter / solo_pro / solo_studio / founding).
// Empty / null gate = no gate (visible to everyone, free).

import { setCors, requireAdmin, supaFetch } from '../_lib/supabase.js'

const ALLOWED_TIERS = new Set(['solo_starter', 'solo_pro', 'solo_studio', 'founding'])

function normalizeGate(input) {
  if (input == null) return null
  if (!Array.isArray(input)) return null
  const cleaned = input
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .filter((v) => ALLOWED_TIERS.has(v))
  return cleaned.length ? cleaned : null
}

const TEMPLATE_FIELDS =
  'id,profile_id,name,description,template_visibility,template_summary,template_guide,template_plan_gate,template_sort_order,template_category,nodes,edges,is_template,created_by,created_at,updated_at'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireAdmin(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      // Admins see every template — public AND private from any user.
      const rows = await supaFetch(
        `spaces?is_template=eq.true&order=template_sort_order.asc,updated_at.desc&select=${TEMPLATE_FIELDS}`
      )
      return res.status(200).json({ templates: Array.isArray(rows) ? rows : [] })
    }

    if (req.method === 'POST') {
      const body = req.body || {}

      // Mode A: promote an existing template (private OR public) to a
      // public template. Only updates the gate / sort_order / metadata
      // fields the admin sent — the nodes/edges payload is left alone.
      if (body.template_id) {
        const id = body.template_id
        const existing = await supaFetch(`spaces?id=eq.${id}&is_template=eq.true&select=id,is_template`)
        if (!existing?.[0]) return res.status(404).json({ error: 'Template not found' })

        const patch = { template_visibility: 'public' }
        if (body.name !== undefined) patch.name = String(body.name).slice(0, 200)
        if (body.summary !== undefined) patch.template_summary = body.summary ? String(body.summary).slice(0, 600) : null
        if (body.guide !== undefined) patch.template_guide = body.guide || null
        if (body.plan_gate !== undefined) patch.template_plan_gate = normalizeGate(body.plan_gate)
        if (body.sort_order !== undefined) patch.template_sort_order = Math.max(0, Math.min(9999, Number(body.sort_order) || 100))
        if (body.category !== undefined) patch.template_category = body.category ? String(body.category).slice(0, 60) : null
        const updated = await supaFetch(`spaces?id=eq.${id}`, { method: 'PATCH', body: patch })
        return res.status(200).json({ template: Array.isArray(updated) ? updated[0] : updated })
      }

      // Mode B: clone an existing space (any owner) into a fresh public
      // template. Useful when admin builds the workflow in their own
      // Spaces canvas, then clicks "Promote to public template" — this
      // copies the nodes/edges into a new template row.
      const sourceId = body.source_id
      if (!sourceId) return res.status(400).json({ error: 'source_id or template_id required' })
      const srcRows = await supaFetch(`spaces?id=eq.${sourceId}&select=*`)
      const src = srcRows?.[0]
      if (!src) return res.status(404).json({ error: 'Source space not found' })

      const created = await supaFetch('spaces', {
        method: 'POST',
        body: {
          profile_id: null,
          name: body.name ? String(body.name).slice(0, 200) : (src.name || 'Untitled template'),
          description: src.description || null,
          nodes: src.nodes || [],
          edges: src.edges || [],
          is_template: true,
          template_visibility: 'public',
          template_summary: body.summary ? String(body.summary).slice(0, 600) : (src.description || src.template_summary || null),
          template_guide: body.guide ?? src.template_guide ?? null,
          template_plan_gate: normalizeGate(body.plan_gate),
          template_sort_order: Math.max(0, Math.min(9999, Number(body.sort_order) || 100)),
          template_category: body.category ? String(body.category).slice(0, 60) : null,
          created_by: auth.user.id,
        },
      })
      return res.status(201).json({ template: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'PATCH') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const existing = await supaFetch(`spaces?id=eq.${id}&is_template=eq.true&select=id`)
      if (!existing?.[0]) return res.status(404).json({ error: 'Template not found' })

      const body = req.body || {}
      const patch = {}
      if (body.name !== undefined) patch.name = String(body.name).slice(0, 200)
      if (body.description !== undefined) patch.description = body.description ? String(body.description).slice(0, 1000) : null
      if (body.summary !== undefined) patch.template_summary = body.summary ? String(body.summary).slice(0, 600) : null
      if (body.guide !== undefined) patch.template_guide = body.guide || null
      if (body.visibility !== undefined) {
        const v = String(body.visibility)
        if (v !== 'public' && v !== 'private') return res.status(400).json({ error: 'visibility must be public or private' })
        patch.template_visibility = v
      }
      if (body.plan_gate !== undefined) patch.template_plan_gate = normalizeGate(body.plan_gate)
      if (body.sort_order !== undefined) patch.template_sort_order = Math.max(0, Math.min(9999, Number(body.sort_order) || 100))
      if (body.category !== undefined) patch.template_category = body.category ? String(body.category).slice(0, 60) : null

      if (!Object.keys(patch).length) return res.status(400).json({ error: 'No editable fields in body' })
      const updated = await supaFetch(`spaces?id=eq.${id}`, { method: 'PATCH', body: patch })
      return res.status(200).json({ template: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const existing = await supaFetch(`spaces?id=eq.${id}&is_template=eq.true&select=id`)
      if (!existing?.[0]) return res.status(404).json({ error: 'Template not found' })
      await supaFetch(`spaces?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
