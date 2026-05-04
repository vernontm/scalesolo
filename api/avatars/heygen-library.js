// GET /api/avatars/heygen-library?profile_id=... → user's HeyGen avatar groups
import { setCors, requireUser, assertProfileAccess } from '../_lib/supabase.js'
import { listAvatarGroups, listLooksForGroup, MODELS } from '../_lib/heygen.js'

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

    const groups = await listAvatarGroups(false)
    return res.status(200).json({ groups: groups?.data?.avatar_group_list || groups?.data || groups })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, data: err.data })
  }
}
