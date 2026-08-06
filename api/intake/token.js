// OPERATOR (authenticated). Generate or rotate the Brand Intake token.
//
// POST /api/intake/token   body: { profile_id }
//   Sets profiles.intake_token to a fresh uuid for a brand the caller owns
//   and returns { token, url } where url is the full public intake link.
//   Rotating (calling again) issues a new token and invalidates the old
//   link. Owner or admin only, mirroring api/profiles.js access checks.

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
    await supaFetch(`profiles?id=eq.${profileId}`, {
      method: 'PATCH',
      body: { intake_token: token },
      prefer: 'return=minimal',
    })

    const url = `${intakeOrigin(req)}/intake/${token}`
    return res.status(200).json({ token, url })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
