// POST /api/avatars/upload-look
// Body: { avatar_id, photo_data_url, angle_order? }
// Adds an additional photo (look) to an existing avatar. Each look becomes its
// own talking_photo on HeyGen so you can render with different poses/outfits.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { createPhotoAvatarFromUrl } from '../_lib/heygen.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

async function uploadToStorage(buffer, path, contentType) {
  const resp = await fetch(
    `${SUPABASE_URL}/storage/v1/object/avatar-media/${encodeURIComponent(path)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        apikey: SERVICE_KEY,
        'Content-Type': contentType,
        'x-upsert': 'true',
      },
      body: buffer,
    }
  )
  if (!resp.ok) {
    const t = await resp.text()
    throw new Error(`storage upload failed: ${resp.status} ${t}`)
  }
  return `${SUPABASE_URL}/storage/v1/object/public/avatar-media/${path}`
}

function decodeDataUrl(dataUrl) {
  const m = (dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/i)
  if (!m) throw Object.assign(new Error('photo_data_url must be a data: URL'), { status: 400 })
  return { mime: m[1], buffer: Buffer.from(m[2], 'base64') }
}

export const config = { api: { bodyParser: { sizeLimit: '12mb' } } }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { avatar_id, photo_data_url, angle_order } = req.body || {}
    if (!avatar_id || !photo_data_url) return res.status(400).json({ error: 'avatar_id + photo_data_url required' })

    const aRows = await supaFetch(`avatars?id=eq.${avatar_id}&select=profile_id,name`)
    const avatar = aRows?.[0]
    if (!avatar) return res.status(404).json({ error: 'Avatar not found' })
    await assertProfileAccess(auth.user.id, avatar.profile_id)

    const { mime, buffer } = decodeDataUrl(photo_data_url)
    const ext = mime.split('/')[1].replace('jpeg', 'jpg')
    const path = `${avatar.profile_id}/${avatar_id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const publicUrl = await uploadToStorage(buffer, path, mime)

    // Create a fresh talking_photo for THIS look so it can be used as its own render character.
    let lookTalkingPhotoId = null
    try {
      const resp = await createPhotoAvatarFromUrl({ imageUrl: publicUrl, name: `${avatar.name} look` })
      lookTalkingPhotoId = resp?.data?.id || resp?.data?.talking_photo_id || resp?.id || null
    } catch (e) {
      // Look is still saved without a HeyGen id — user can retry render later.
      console.warn('[upload-look] HeyGen rejected:', e.message)
    }

    const created = await supaFetch('avatar_looks', {
      method: 'POST',
      body: {
        profile_id: avatar.profile_id,
        avatar_id,
        image_url: publicUrl,
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
