// GET /api/scheduling/next-slot?profile_id=...
// Returns: { iso, profile: { timezone, posting_schedule } }
//
// Wraps findNextOpenSlot so the client (schedule_post node body) can
// preview where an "auto" scheduled post would land without duplicating
// the slot-walking logic.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { findNextOpenSlot } from '../_lib/scheduling.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const profile_id = req.query.profile_id
    if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
    await assertProfileAccess(auth.user.id, profile_id)

    const rows = await supaFetch(`profiles?id=eq.${profile_id}&select=id,timezone,posting_schedule`)
    const profile = rows?.[0]
    if (!profile) return res.status(404).json({ error: 'Profile not found' })

    // Avoid colliding with already-scheduled posts on this profile.
    const taken = await supaFetch(
      `content_scripts?profile_id=eq.${profile_id}&status=eq.scheduled&select=scheduled_datetime`
    ).catch(() => [])
    const takenIso = (taken || []).map((r) => r.scheduled_datetime).filter(Boolean)

    const iso = findNextOpenSlot(profile, takenIso)
    return res.status(200).json({
      iso,
      profile: { timezone: profile.timezone, posting_schedule: profile.posting_schedule },
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
