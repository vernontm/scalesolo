// Admin CRUD for default avatars + their looks.
//
//   GET  /api/admin/default-avatars         → list all (active + inactive)
//   POST /api/admin/default-avatars         → create avatar
//   PATCH /api/admin/default-avatars?id=…   → update avatar
//   DELETE /api/admin/default-avatars?id=…  → soft-delete (is_active=false)
//
//   POST   /api/admin/default-avatars?id=…&action=add_look       body { image_url, heygen_look_id?, label?, angle_order? }
//   DELETE /api/admin/default-avatars?id=…&action=delete_look&look_id=…
//
// All endpoints require requireAdmin (checks user_profiles.is_admin).

import { setCors, requireAdmin, supaFetch } from '../_lib/supabase.js'

const AVATAR_ALLOWED = new Set([
  'name', 'description', 'heygen_group_id', 'elevenlabs_voice_id',
  'default_voice_label', 'preview_image_url', 'sort_order', 'is_active',
])

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireAdmin(req, res)
  if (!auth) return

  try {
    const id = req.query.id
    const action = req.query.action

    if (req.method === 'GET') {
      const rows = await supaFetch(
        'default_avatars?select=*,looks:default_avatar_looks(id,image_url,heygen_look_id,label,angle_order,created_at)' +
        '&order=sort_order.asc,created_at.asc'
      )
      return res.status(200).json({ avatars: rows || [] })
    }

    if (req.method === 'POST' && !action) {
      const body = req.body || {}
      if (!body.name || !String(body.name).trim()) {
        return res.status(400).json({ error: 'name required' })
      }
      const row = { created_by: auth.user.id }
      for (const [k, v] of Object.entries(body)) {
        if (AVATAR_ALLOWED.has(k) && v !== undefined) row[k] = v
      }
      const created = await supaFetch('default_avatars', {
        method: 'POST',
        body: row,
      })
      return res.status(201).json({ avatar: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'PATCH') {
      if (!id) return res.status(400).json({ error: 'id required' })
      const body = req.body || {}
      const updates = { updated_at: new Date().toISOString() }
      for (const [k, v] of Object.entries(body)) {
        if (AVATAR_ALLOWED.has(k) && v !== undefined) updates[k] = v
      }
      const updated = await supaFetch(
        `default_avatars?id=eq.${encodeURIComponent(id)}`,
        { method: 'PATCH', body: updates },
      )
      return res.status(200).json({ avatar: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE' && !action) {
      if (!id) return res.status(400).json({ error: 'id required' })
      // Soft-delete: flip is_active=false so any user mid-render with
      // this avatar's heygen_group_id keeps working. Hard delete would
      // cascade out the looks too — fine if you really want it gone,
      // but soft is safer. Use ?hard=1 for a real cascade delete.
      if (req.query.hard === '1') {
        await supaFetch(`default_avatars?id=eq.${encodeURIComponent(id)}`, {
          method: 'DELETE',
          prefer: 'return=minimal',
        })
      } else {
        await supaFetch(`default_avatars?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: { is_active: false, updated_at: new Date().toISOString() },
          prefer: 'return=minimal',
        })
      }
      return res.status(204).end()
    }

    // ── looks ────────────────────────────────────────────────────────
    if (req.method === 'POST' && action === 'add_look') {
      if (!id) return res.status(400).json({ error: 'id required' })
      const body = req.body || {}
      if (!body.image_url) return res.status(400).json({ error: 'image_url required' })
      const created = await supaFetch('default_avatar_looks', {
        method: 'POST',
        body: {
          default_avatar_id: id,
          image_url: body.image_url,
          heygen_look_id: body.heygen_look_id || null,
          label: body.label || null,
          angle_order: Number.isFinite(Number(body.angle_order)) ? Number(body.angle_order) : 0,
        },
      })
      return res.status(201).json({ look: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'DELETE' && action === 'delete_look') {
      const lookId = req.query.look_id
      if (!lookId) return res.status(400).json({ error: 'look_id required' })
      await supaFetch(`default_avatar_looks?id=eq.${encodeURIComponent(lookId)}`, {
        method: 'DELETE',
        prefer: 'return=minimal',
      })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
