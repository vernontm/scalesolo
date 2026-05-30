// GET  /api/account/social-tags?profile_id=<uuid>  → { tags: { threads: "...", ... } }
// PUT  /api/account/social-tags                    → body: { profile_id, tags: {...} }
//
// Read / write the per-platform tag map stored on profiles.social_platform_tags.
// Plumbed into /api/social/upload-post.js so e.g. every Threads post
// auto-suffixes the brand's preferred tag (#aithreads for VTM) without
// the user having to type it.
//
// Tag values are stored verbatim. The publish path decides how to
// format them (hashtag vs mention vs raw text). We sanitize here only
// to strip whitespace and cap length so a runaway paste can't bloat
// the row.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

const SUPPORTED_PLATFORMS = new Set([
  'threads', 'instagram', 'twitter', 'facebook',
  'tiktok', 'youtube', 'linkedin', 'pinterest', 'bluesky', 'reddit',
])
const MAX_TAG_LEN = 80  // hashtag / handle limit on every platform

function sanitizeTags(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const out = {}
  for (const [k, v] of Object.entries(input)) {
    const key = String(k).toLowerCase().trim()
    if (!SUPPORTED_PLATFORMS.has(key)) continue
    const val = String(v ?? '').trim().slice(0, MAX_TAG_LEN)
    // Empty value = explicit "remove tag for this platform". Keep the
    // key so the PUT semantics are "replace the whole map" — drop
    // empties only at write time so the row stays compact.
    if (val) out[key] = val
  }
  return out
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const profileId = String(req.query.profile_id || '').trim()
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)
      const rows = await supaFetch(`profiles?id=eq.${profileId}&select=social_platform_tags`)
      return res.status(200).json({ tags: rows?.[0]?.social_platform_tags || {} })
    }

    if (req.method === 'PUT') {
      const { profile_id: profileId, tags } = req.body || {}
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)
      const clean = sanitizeTags(tags)
      const updated = await supaFetch(`profiles?id=eq.${profileId}`, {
        method: 'PATCH',
        body: { social_platform_tags: clean },
      })
      const row = Array.isArray(updated) ? updated[0] : updated
      return res.status(200).json({ tags: row?.social_platform_tags || clean })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || String(e) })
  }
}
