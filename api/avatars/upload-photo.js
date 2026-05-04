// POST /api/avatars/upload-photo
// Body: { profile_id, name, model_version, photo_url }
//
// The browser uploads the image to Supabase Storage directly (no Vercel
// 4.5 MB body cap), then sends us just the resulting public URL.
// We call HeyGen Photo Avatar to mint a talking_photo_id and persist the row.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { createPhotoAvatarFromUrl, MODELS } from '../_lib/heygen.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, name, model_version, photo_url } = req.body || {}
    if (!profile_id || !name || !photo_url) {
      return res.status(400).json({ error: 'profile_id + name + photo_url required' })
    }
    if (!MODELS[model_version]) return res.status(400).json({ error: 'Unknown model_version' })
    await assertProfileAccess(auth.user.id, profile_id)

    // Best-effort: ask HeyGen to mint a talking_photo from the URL.
    // If it fails, persist the avatar anyway so the user can retry.
    let talkingPhotoId = null
    let trainingError = null
    let trainingStatus = 'ready'
    try {
      const heygenResp = await createPhotoAvatarFromUrl({ imageUrl: photo_url, name })
      // HeyGen's photo avatar API has shifted shape over time. Accept any of:
      //   data.id              (legacy direct talking_photo)
      //   data.talking_photo_id
      //   data.generation_id   (current async pipeline — avatar trains on
      //                         their side; we treat it as the persistent
      //                         identifier and mark the row as training)
      //   id                   (top-level fallback)
      const data = heygenResp?.data || {}
      talkingPhotoId = data.id || data.talking_photo_id || data.generation_id || heygenResp?.id || null
      if (!talkingPhotoId) {
        trainingStatus = 'failed'
        trainingError = `HeyGen response missing id (got: ${JSON.stringify(heygenResp).slice(0, 200)})`
      } else if (data.generation_id && !data.id && !data.talking_photo_id) {
        // We got a generation_id only — the avatar is still being trained on
        // HeyGen's side. Mark accordingly so the UI shows "training" instead
        // of pretending it's ready (or that it failed).
        trainingStatus = 'training'
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
        model_version,
        photo_url,
        thumbnail_url: photo_url,
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
