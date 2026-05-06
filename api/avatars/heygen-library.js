// GET /api/avatars/heygen-library?profile_id=... → HeyGen's public/stock
// avatar groups, with our account's own custom avatars filtered out so one
// user's uploads never leak into another user's picker.
//
// Strategy: ask HeyGen for groups twice — once with include_public=false
// (returns ONLY groups created in our API-key account) and once with
// include_public=true (returns our account + HeyGen's public library).
// Subtract by group id to get just the public set.
import { setCors, requireUser, assertProfileAccess } from '../_lib/supabase.js'
import { listAvatarGroups } from '../_lib/heygen.js'

function extractGroups(payload) {
  return payload?.data?.avatar_group_list || payload?.data || payload || []
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const profileId = req.query.profile_id
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })
    await assertProfileAccess(auth.user.id, profileId)

    // HeyGen library disabled — users now create their own avatars from
    // uploads via the Avatars page only. Endpoint kept (returns empty) so
    // older deployed clients don't 404.
    return res.status(200).json({ groups: [] })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, data: err.data })
  }
}
