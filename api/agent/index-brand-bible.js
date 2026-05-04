// POST /api/agent/index-brand-bible { profile_id }
// (Re-)embeds the profile's brand bible into agent_knowledge_chunks.
// Called from the BrandBibleEditor on save, or manually from Settings.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { indexBrandBible } from '../_lib/embeddings.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const profileId = req.body?.profile_id
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })
    await assertProfileAccess(auth.user.id, profileId)

    const rows = await supaFetch(`profiles?id=eq.${profileId}&select=brand_bible`)
    const brandBible = rows?.[0]?.brand_bible || ''
    const result = await indexBrandBible(profileId, brandBible)
    return res.status(200).json(result)
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
