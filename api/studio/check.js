// GET /api/studio/check
//
// Lightweight probe the frontend calls on mount of the /studio route to
// decide whether to show Studio or render NotFound. Returns:
//
//   { allowed: true }   — the user is on the STUDIO_BETA_USER_IDS list
//   { allowed: false }  — the user is signed in but not on the list
//
// Auth-failed responses fall through to requireUser's 401, which the
// frontend treats the same as "not allowed" (i.e. renders NotFound).
//
// Intentionally does NOT 404 here — the frontend needs a real response
// so it can swap the UI. The 404 trick lives on Studio's data endpoints
// where leaking the route's existence would be more useful to a probe.

import { setCors, requireUser } from '../_lib/supabase.js'
import { isStudioBetaUser } from './_lib/gate.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  return res.status(200).json({ allowed: isStudioBetaUser(auth.user.id) })
}
