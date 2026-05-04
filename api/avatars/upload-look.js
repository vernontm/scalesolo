// POST /api/avatars/upload-look
// Body: { avatar_id, photo_url, angle_order? }
// Browser uploads to Supabase Storage; we just receive the URL.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { createPhotoAvatarFromUrl } from '../_lib/heygen.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { avatar_id, photo_url, angle_order } = req.body || {}
    if (!avatar_id || !photo_url) return res.status(400).json({ error: 'avatar_id + photo_url required' })

    const aRows = await supaFetch(`avatars?id=eq.${avatar_id}&select=profile_id,name`)
    const avatar = aRows?.[0]
    if (!avatar) return res.status(404).json({ error: 'Avatar not found' })
    await assertProfileAccess(auth.user.id, avatar.profile_id)

    let lookTalkingPhotoId = null
    try {
      const resp = await createPhotoAvatarFromUrl({ imageUrl: photo_url, name: `${avatar.name} look` })
      lookTalkingPhotoId = resp?.data?.id || resp?.data?.talking_photo_id || resp?.id || null
    } catch (e) {
      console.warn('[upload-look] HeyGen rejected:', e.message)
    }

    const created = await supaFetch('avatar_looks', {
      method: 'POST',
      body: {
        profile_id: avatar.profile_id,
        avatar_id,
        image_url: photo_url,
        heygen_look_id: lookTalkingPhotoId,
        angle_order: angle_order ?? 0,
        kind: 'upload',
      },
    })
    return res.status(201).json({ look: Array.isArray(created) ? created[0] : created })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
