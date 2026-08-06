// OPERATOR (authenticated). List Brand Intake submissions for a brand.
//
// GET /api/intake/submissions?profile_id=<uuid>
//   Returns the brand's submissions (newest first) for a brand the caller
//   owns. Owner / admin only, mirroring api/profiles.js access checks. Reads
//   via the service role after the ownership check (the table has RLS on and
//   no anon policy, so this is the only read path).

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return
  const userId = auth.user.id

  try {
    const profileId = req.query.profile_id
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })

    // Owner / admin only. assertProfileAccess also validates uuid shape.
    const role = await assertProfileAccess(userId, profileId)
    if (!['owner', 'admin'].includes(role)) return res.status(403).json({ error: 'Forbidden' })

    const rows = await supaFetch(
      `brand_intake_submissions?profile_id=eq.${profileId}&order=created_at.desc&select=id,answers,summary_md,status,created_at`
    )
    return res.status(200).json({ submissions: Array.isArray(rows) ? rows : [] })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
