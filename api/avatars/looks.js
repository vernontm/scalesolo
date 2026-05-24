// PATCH /api/avatars/looks?id=<look-uuid>
//
// Lightweight metadata-update endpoint for avatar_looks rows. Studio's
// inline orientation tagger (and any future name/notes editors) hit
// this with a tiny body like { orientation: 'portrait' } rather than
// pulling in the heavier per-look render/upload endpoints.
//
// Access: same RLS rule the rest of the app uses — the look's
// profile_id must be one the user has access to. We resolve the
// avatar's profile_id first, then assertProfileAccess.
//
// Whitelist of editable columns is deliberately tiny. heygen_look_id,
// image_url, avatar_id, profile_id are NEVER editable from here —
// those are owned by the training pipeline.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

const ALLOWED_FIELDS = new Set(['orientation', 'name'])
const ALLOWED_ORIENTATIONS = new Set(['portrait', 'landscape', 'square'])

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  const lookId = req.query.id
  if (!lookId) return res.status(400).json({ error: 'id required' })

  try {
    // Load the look's profile_id to authorize via has_profile_access.
    const rows = await supaFetch(`avatar_looks?id=eq.${lookId}&select=id,profile_id&limit=1`)
    const look = rows?.[0]
    if (!look) return res.status(404).json({ error: 'Look not found' })
    await assertProfileAccess(auth.user.id, look.profile_id)

    const updates = {}
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!ALLOWED_FIELDS.has(k)) continue
      if (k === 'orientation') {
        // null clears the tag; any other value must be in the allowlist.
        if (v === null || v === '') updates.orientation = null
        else if (ALLOWED_ORIENTATIONS.has(v)) updates.orientation = v
        else return res.status(400).json({ error: `orientation must be one of portrait, landscape, square (got ${v})` })
      } else if (k === 'name') {
        updates.name = typeof v === 'string' ? v.slice(0, 120) : null
      }
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No editable fields in body' })

    const patched = await supaFetch(`avatar_looks?id=eq.${lookId}`, {
      method: 'PATCH', body: updates,
    })
    return res.status(200).json({ look: Array.isArray(patched) ? patched[0] : patched })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
