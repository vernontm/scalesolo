// /api/avatars/look-images
//   GET    ?look_id=...                 list images in a look (ordered)
//   POST   { look_id, image_url, name?, order_index? }
//   PATCH  ?id=...   { name?, order_index?, image_url? }
//   DELETE ?id=...

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const look_id = req.query.look_id
      if (!look_id) return res.status(400).json({ error: 'look_id required' })
      const lk = await supaFetch(`avatar_looks?id=eq.${look_id}&select=profile_id`)
      const profile_id = lk?.[0]?.profile_id
      if (!profile_id) return res.status(404).json({ error: 'Look not found' })
      await assertProfileAccess(auth.user.id, profile_id)
      const rows = await supaFetch(
        `avatar_look_images?look_id=eq.${look_id}&select=*&order=order_index.asc,created_at.asc`
      )
      return res.status(200).json({ images: rows || [] })
    }

    if (req.method === 'POST') {
      const { look_id, image_url, name, order_index } = req.body || {}
      if (!look_id || !image_url) return res.status(400).json({ error: 'look_id + image_url required' })
      const lk = await supaFetch(`avatar_looks?id=eq.${look_id}&select=profile_id`)
      const profile_id = lk?.[0]?.profile_id
      if (!profile_id) return res.status(404).json({ error: 'Look not found' })
      await assertProfileAccess(auth.user.id, profile_id)

      // Compute next order_index if not supplied
      let idx = Number.isFinite(order_index) ? order_index : null
      if (idx === null) {
        const max = await supaFetch(`avatar_look_images?look_id=eq.${look_id}&select=order_index&order=order_index.desc&limit=1`)
        idx = (max?.[0]?.order_index ?? -1) + 1
      }

      const created = await supaFetch('avatar_look_images', {
        method: 'POST',
        body: { look_id, profile_id, image_url, name: name || null, order_index: idx },
      })
      return res.status(201).json({ image: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'PATCH') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`avatar_look_images?id=eq.${id}&select=profile_id`)
      const profile_id = rows?.[0]?.profile_id
      if (!profile_id) return res.status(404).json({ error: 'Image not found' })
      await assertProfileAccess(auth.user.id, profile_id)
      const updates = {}
      for (const k of ['name', 'order_index', 'image_url']) {
        if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) updates[k] = req.body[k]
      }
      const updated = await supaFetch(`avatar_look_images?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ image: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`avatar_look_images?id=eq.${id}&select=profile_id`)
      const profile_id = rows?.[0]?.profile_id
      if (!profile_id) return res.status(404).json({ error: 'Image not found' })
      await assertProfileAccess(auth.user.id, profile_id)
      await supaFetch(`avatar_look_images?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
