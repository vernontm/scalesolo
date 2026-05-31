// POST /api/avatars/looks/save
//
// Final step of the New Look modal. Takes the user's approved set of
// generated images and writes:
//
//   1. One row into avatar_looks (the wrapper). Cover photo = first
//      image (typically the hero shot). Sent through HeyGen V3
//      photo-avatar creation so the look is render-ready immediately.
//
//   2. One row per generated image into avatar_look_images, in the
//      order the client provides (hero / 45L / 45R / 90L by default).
//
// Body:
//   {
//     avatar_id,                    // existing avatar to attach to
//     name?,                        // optional display name
//     orientation: 'portrait' | 'landscape',
//     images: [{ url, label? }, …]  // first entry is the cover
//   }
//
// Returns: { look } (with id + heygen_look_id + training_status).
//
// This is the only place the look becomes durable — everything before
// it (compose, angles) is preview-only.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../../_lib/supabase.js'
import { createPhotoAvatarV3 } from '../../_lib/heygen.js'

export const config = { maxDuration: 60 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { avatar_id, name, orientation, images } = req.body || {}
    if (!avatar_id) return res.status(400).json({ error: 'avatar_id required' })
    if (!Array.isArray(images) || !images.length) {
      return res.status(400).json({ error: 'images (non-empty array) required' })
    }
    const cover = images[0]?.url
    if (!cover) return res.status(400).json({ error: 'images[0].url required (cover photo)' })

    const aRows = await supaFetch(`avatars?id=eq.${avatar_id}&select=profile_id,name`)
    const avatar = aRows?.[0]
    if (!avatar) return res.status(404).json({ error: 'Avatar not found' })
    await assertProfileAccess(auth.user.id, avatar.profile_id)

    // Find the next angle_order so multiple looks stack cleanly under
    // this avatar (same logic as the simple upload path).
    const existing = await supaFetch(`avatar_looks?avatar_id=eq.${avatar_id}&select=angle_order&order=angle_order.desc&limit=1`)
    const nextOrder = (existing?.[0]?.angle_order ?? -1) + 1

    // Train the look's cover with HeyGen V3 synchronously. Same
    // best-effort pattern as upload-look.js — failures don't block the
    // local row, they just mark training_status='failed' so the user
    // can retry from the UI.
    let heygenLookId = null
    let trainingStatus = 'training'
    let trainingError = null
    try {
      const resp = await createPhotoAvatarV3({
        imageUrl: cover,
        name: name || `${avatar.name || 'Look'} ${nextOrder + 1}`,
      })
      heygenLookId = resp?.data?.avatar_item?.id || resp?.data?.id || resp?.id || null
      if (heygenLookId) {
        trainingStatus = 'ready'
      } else {
        trainingStatus = 'failed'
        trainingError = `HeyGen V3 response missing avatar id (got: ${JSON.stringify(resp).slice(0, 200)})`
      }
    } catch (e) {
      trainingStatus = 'failed'
      trainingError = e.message
    }

    const lookOrient = orientation === 'horizontal' ? 'landscape'
      : orientation === 'vertical' ? 'portrait'
      : (orientation || null)

    const created = await supaFetch('avatar_looks', {
      method: 'POST',
      body: {
        profile_id: avatar.profile_id,
        avatar_id,
        image_url: cover,
        name: name || null,
        angle_order: nextOrder,
        kind: 'upload',
        orientation: lookOrient,
        heygen_look_id: heygenLookId,
        training_status: trainingStatus,
        training_error: trainingError,
        trained_at: heygenLookId ? new Date().toISOString() : null,
      },
    })
    const look = Array.isArray(created) ? created[0] : created

    // Bulk-insert all images. Order matches the array the client sent.
    // We use Prefer: return=minimal so we don't ping back N rows we
    // don't need — the client already knows what it sent.
    const imageRows = images.map((img, i) => ({
      look_id: look.id,
      profile_id: avatar.profile_id,
      image_url: img.url,
      name: img.label || null,
      order_index: i,
    })).filter((row) => row.image_url)
    if (imageRows.length) {
      await supaFetch('avatar_look_images', {
        method: 'POST',
        prefer: 'return=minimal',
        body: imageRows,
      })
    }

    return res.status(201).json({ look })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
