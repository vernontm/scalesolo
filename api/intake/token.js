// OPERATOR (authenticated). Generate or rotate the Brand Intake token.
//
// POST /api/intake/token   body: { profile_id }
//   Upserts a fresh uuid into brand_intake_tokens (one row per brand) and
//   returns { token, url } where url is the full public intake link.
//   Rotating (calling again) replaces the token in place and invalidates
//   the old link. Owner or admin only, mirroring api/profiles.js checks.
//
//   Tokens live in the service-role-only brand_intake_tokens table
//   (migration 0067), NOT on the profiles row: profiles is readable by
//   every collaborator role via GET /api/profiles and the profiles_select
//   RLS policy, and the intake token is a bearer secret that only owners
//   and admins may handle.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

function intakeOrigin(req) {
  // Prefer the request origin (the operator's own app host), fall back to
  // the forwarded host, then the production domain. Keeps the copied link
  // pointing at whatever environment generated it (prod / preview / local).
  const origin = req.headers.origin
  if (origin) return origin.replace(/\/$/, '')
  const host = req.headers['x-forwarded-host'] || req.headers.host
  if (host) {
    const proto = req.headers['x-forwarded-proto'] || 'https'
    return `${proto}://${host}`
  }
  return 'https://scalesolo.ai'
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return
  const userId = auth.user.id

  try {
    const profileId = req.body?.profile_id
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })

    // Owner / admin only. assertProfileAccess also validates uuid shape.
    const role = await assertProfileAccess(userId, profileId)
    if (!['owner', 'admin'].includes(role)) return res.status(403).json({ error: 'Forbidden' })

    const token = crypto.randomUUID()
    // Upsert keyed on profile_id: first call creates the row, later calls
    // rotate the token in place.
    await supaFetch('brand_intake_tokens?on_conflict=profile_id', {
      method: 'POST',
      body: { profile_id: profileId, token },
      prefer: 'resolution=merge-duplicates,return=minimal',
    })

    const url = `${intakeOrigin(req)}/intake/${token}`
    return res.status(200).json({ token, url })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
