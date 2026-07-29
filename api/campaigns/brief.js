// POST /api/campaigns/brief
//
// Edit a campaign post's media brief BEFORE generation — the review step.
// The planner writes a prompt + reference_asset_ids into each post's
// media_brief; this lets the user see and revise them (fix the prompt,
// swap to the right real photo, change the content type) and approve
// before any credits are spent.
//
// Body: { content_id, prompt?, reference_asset_ids?, content_type? }
//   - Only provided fields are changed; the rest of media_brief is kept.
//   - reference_asset_ids are validated against the profile's real assets.
//   - Editing a brief invalidates any previously generated media for that
//     post (it was built from the old prompt), so we clear media_urls and
//     the generation state — the next Generate runs fresh.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

const CONTENT_TYPES = new Set(['image', 'carousel', 'video', 'promo', 'mood', 'text'])
const MEDIA_TYPE_FOR = { text: 'text', promo: 'image', mood: 'image', image: 'image', carousel: 'carousel', video: 'video' }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const body = req.body || {}
    const contentId = body.content_id
    if (!contentId) return res.status(400).json({ error: 'content_id required' })

    const rows = await supaFetch(
      `content_scripts?id=eq.${contentId}&select=id,profile_id,media_brief,media_type&limit=1`,
    )
    const row = rows?.[0]
    if (!row) return res.status(404).json({ error: 'post not found' })
    await assertProfileAccess(auth.user.id, row.profile_id)

    const brief = (row.media_brief && typeof row.media_brief === 'object') ? { ...row.media_brief } : {}

    if (body.prompt !== undefined) brief.prompt = String(body.prompt || '').slice(0, 2000)

    if (Array.isArray(body.reference_asset_ids)) {
      // Validate the chosen ids belong to this profile's asset library.
      const ids = body.reference_asset_ids.filter(Boolean).slice(0, 8)
      let valid = []
      if (ids.length) {
        const assets = await supaFetch(
          `brand_assets?profile_id=eq.${row.profile_id}&id=in.(${ids.map((s) => `"${s}"`).join(',')})&select=id`,
        ).catch(() => [])
        const ok = new Set((assets || []).map((a) => a.id))
        valid = ids.filter((id) => ok.has(id))
      }
      brief.reference_asset_ids = valid
      brief.exact_lock = brief.exact_lock !== false && valid.length > 0
    }

    const patch = { media_brief: brief }

    if (body.content_type !== undefined && CONTENT_TYPES.has(body.content_type)) {
      brief.content_type = body.content_type
      patch.media_type = MEDIA_TYPE_FOR[body.content_type] || 'image'
    }

    // Editing the brief invalidates old media (built from the prior
    // prompt). Clear it so the next Generate produces fresh media the
    // user actually approved. Nothing is published, so this is safe.
    patch.media_urls = null
    patch.media_url_with_cover = null
    patch.media_gen_status = null
    patch.media_jobs = null
    patch.media_gen_error = null

    const updated = await supaFetch(`content_scripts?id=eq.${contentId}`, {
      method: 'PATCH', body: patch,
    })
    return res.status(200).json({ post: Array.isArray(updated) ? updated[0] : updated })
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || String(e) })
  }
}
