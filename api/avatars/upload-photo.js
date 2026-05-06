// POST /api/avatars/upload-photo
// Body: { profile_id, name, photo_url }
//
// Synchronous photo-avatar creation via HeyGen V3 /v3/avatars endpoint.
// Returns immediately with a usable avatar_id — no async training step.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { createPhotoAvatarV3 } from '../_lib/heygen.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, name, photo_url } = req.body || {}
    if (!profile_id || !name || !photo_url) {
      return res.status(400).json({ error: 'profile_id + name + photo_url required' })
    }
    await assertProfileAccess(auth.user.id, profile_id)

    let avatarId = null
    let trainingStatus = 'ready'
    let trainingError = null
    try {
      const resp = await createPhotoAvatarV3({ imageUrl: photo_url, name })
      avatarId = resp?.data?.avatar_item?.id || resp?.data?.id || resp?.id || null
      if (!avatarId) {
        trainingStatus = 'failed'
        trainingError = `HeyGen V3 response missing avatar id (got: ${JSON.stringify(resp).slice(0, 200)})`
      }
    } catch (e) {
      trainingStatus = 'failed'
      trainingError = e.message
    }

    const created = await supaFetch('avatars', {
      method: 'POST',
      body: {
        profile_id,
        name,
        photo_url,
        thumbnail_url: photo_url,
        // The V3 avatar id IS the renderable id — no training step.
        talking_photo_id: avatarId,
        training_status: trainingStatus,
        training_error: trainingError,
      },
    })
    const avatar = Array.isArray(created) ? created[0] : created

    await supaFetch('avatar_looks', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        profile_id,
        avatar_id: avatar.id,
        image_url: photo_url,
        kind: 'upload',
        angle_order: 0,
      },
    })

    return res.status(201).json({ avatar, training_error: trainingError })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
