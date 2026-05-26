// POST /api/avatars/looks/train?id=<look_id>
//
// Trains an existing avatar_looks row on HeyGen so it picks up a
// heygen_look_id and becomes usable in the studio render pipeline.
//
// Used by the Avatars page Train button to backfill looks created
// before the auto-training flow shipped (these have heygen_look_id =
// null, training_status = 'pending'). The same flow also retries
// 'failed' looks — fixes a transient HeyGen hiccup without making the
// user re-upload.
//
// HeyGen V3 photo avatars are synchronous: createPhotoAvatarV3 either
// returns a usable avatar_id immediately or errors. There's no
// background polling to manage. The row's training_status transitions
// straight from whatever it was → 'ready' (or 'failed' on error).

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../../_lib/supabase.js'
import { createPhotoAvatarV3 } from '../../_lib/heygen.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const lookId = req.query.id
    if (!lookId) return res.status(400).json({ error: 'look id required in query (?id=…)' })

    const lookRows = await supaFetch(
      `avatar_looks?id=eq.${lookId}&select=id,profile_id,image_url,name,heygen_look_id,training_status,avatar_id,avatars(name)`,
    )
    const look = lookRows?.[0]
    if (!look) return res.status(404).json({ error: 'Look not found' })
    await assertProfileAccess(auth.user.id, look.profile_id)

    if (!look.image_url) {
      return res.status(400).json({ error: 'Look has no image_url — re-upload an image before training.' })
    }
    if (look.heygen_look_id && look.training_status === 'ready') {
      // Already trained — return as-is so the UI can move on. Pass
      // ?force=1 to retrain (e.g. user replaced the cover image).
      if (req.query.force !== '1') {
        return res.status(200).json({ ok: true, look, skipped: 'already_trained' })
      }
    }

    // Mark in-flight so the UI can show a spinner. Cheap PATCH; if
    // the HeyGen call below succeeds in the same request, this gets
    // overwritten to 'ready' before the user notices.
    await supaFetch(`avatar_looks?id=eq.${lookId}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { training_status: 'training', training_error: null },
    })

    let heygenLookId = null
    let trainingError = null
    try {
      const resp = await createPhotoAvatarV3({
        imageUrl: look.image_url,
        name: look.name || look.avatars?.name || 'ScaleSolo look',
      })
      heygenLookId = resp?.data?.avatar_item?.id || resp?.data?.id || resp?.id || null
      if (!heygenLookId) {
        trainingError = `HeyGen V3 response missing avatar id (got: ${JSON.stringify(resp).slice(0, 200)})`
      }
    } catch (e) {
      trainingError = e?.message || String(e)
    }

    const updates = heygenLookId
      ? {
          heygen_look_id: heygenLookId,
          training_status: 'ready',
          training_error: null,
          trained_at: new Date().toISOString(),
        }
      : {
          training_status: 'failed',
          training_error: trainingError || 'Unknown HeyGen failure',
        }

    const patched = await supaFetch(`avatar_looks?id=eq.${lookId}`, {
      method: 'PATCH',
      body: updates,
    })
    const updated = Array.isArray(patched) ? patched[0] : patched

    if (!heygenLookId) {
      return res.status(502).json({ error: trainingError || 'HeyGen training failed', look: updated })
    }
    return res.status(200).json({ ok: true, look: updated })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || String(err) })
  }
}
