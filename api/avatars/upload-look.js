// POST /api/avatars/upload-look
// Body: { avatar_id, photo_url, name? }
// Creates a new "look" folder for the avatar (V3 photo→video pipeline) and
// drops the first image into avatar_look_images so it shows up immediately
// in the spaces avatar picker grid.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { avatar_id, photo_url, name } = req.body || {}
    if (!avatar_id || !photo_url) return res.status(400).json({ error: 'avatar_id + photo_url required' })

    const aRows = await supaFetch(`avatars?id=eq.${avatar_id}&select=profile_id,name`)
    const avatar = aRows?.[0]
    if (!avatar) return res.status(404).json({ error: 'Avatar not found' })
    await assertProfileAccess(auth.user.id, avatar.profile_id)

    // Find the next angle_order so multiple looks stack cleanly.
    const existing = await supaFetch(`avatar_looks?avatar_id=eq.${avatar_id}&select=angle_order&order=angle_order.desc&limit=1`)
    const nextOrder = (existing?.[0]?.angle_order ?? -1) + 1

    const created = await supaFetch('avatar_looks', {
      method: 'POST',
      body: {
        profile_id: avatar.profile_id,
        avatar_id,
        image_url: photo_url,        // legacy single-cover field still set
        name: name || null,
        angle_order: nextOrder,
        kind: 'upload',
      },
    })
    const look = Array.isArray(created) ? created[0] : created

    // Drop the same photo into avatar_look_images so the new folder isn't
    // empty when the user opens it.
    await supaFetch('avatar_look_images', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        look_id: look.id,
        profile_id: avatar.profile_id,
        image_url: photo_url,
        order_index: 0,
      },
    })

    return res.status(201).json({ look })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
