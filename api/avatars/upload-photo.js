// POST /api/avatars/upload-photo
// Body: { profile_id, name, model_version, photo_data_url }
//       (data URL: data:image/jpeg;base64,xxx — keeps the request body single-shot
//        and avoids multipart parsing complexity in Vercel Node functions)
//
// Pipeline:
// 1. Decode data URL → buffer
// 2. Upload to Supabase Storage (avatar-media bucket) → public URL
// 3. POST that URL to HeyGen Photo Avatar endpoint to get talking_photo_id
// 4. Insert avatars row + a single avatar_looks row with the photo

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { createPhotoAvatarFromUrl, MODELS } from '../_lib/heygen.js'

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

export const config = {
  api: { bodyParser: { sizeLimit: '12mb' } },
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, name, model_version, photo_data_url } = req.body || {}
    if (!profile_id || !name || !photo_data_url) {
      return res.status(400).json({ error: 'profile_id + name + photo_data_url required' })
    }
    if (!MODELS[model_version]) return res.status(400).json({ error: 'Unknown model_version' })
    await assertProfileAccess(auth.user.id, profile_id)

    // 1. Decode + upload to Storage
    const { mime, buffer } = decodeDataUrl(photo_data_url)
    const ext = mime.split('/')[1].replace('jpeg', 'jpg')
    const path = `${profile_id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const publicUrl = await uploadToStorage(buffer, path, mime)

    // 2. Create HeyGen Photo Avatar (talking_photo_id) — best-effort, don't fail
    //    the whole request if HeyGen barfs. We'll persist the avatar row anyway
    //    and surface the error so the user can retry.
    let talkingPhotoId = null
    let trainingError = null
    let trainingStatus = 'ready'
    try {
      const heygenResp = await createPhotoAvatarFromUrl({ imageUrl: publicUrl, name })
      talkingPhotoId = heygenResp?.data?.id || heygenResp?.data?.talking_photo_id || heygenResp?.id || null
      if (!talkingPhotoId) {
        trainingStatus = 'failed'
        trainingError = `HeyGen response missing id (got: ${JSON.stringify(heygenResp).slice(0, 200)})`
      }
    } catch (e) {
      trainingStatus = 'failed'
      trainingError = e.message
    }

    // 3. Insert avatar + look
    const created = await supaFetch('avatars', {
      method: 'POST',
      body: {
        profile_id,
        name,
        model_version,
        photo_url: publicUrl,
        thumbnail_url: publicUrl,
        talking_photo_id: talkingPhotoId,
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
        image_url: publicUrl,
        kind: 'upload',
        angle_order: 0,
      },
    })

    return res.status(201).json({ avatar, training_error: trainingError })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
