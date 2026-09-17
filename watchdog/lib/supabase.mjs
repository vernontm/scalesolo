// Read-only Supabase REST access for the watchdog.
//
// The app already writes a `post.published` notification the moment a post
// goes live, with meta = { platforms, post_url, content_id }. We tail that
// table instead of touching the posting pipeline at all.

function headers(key) {
  return { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }
}

/**
 * New post.published notifications created after `sinceIso`, oldest first.
 * @returns {Promise<Array<{id,created_at,profile_id,meta,title}>>}
 */
export async function fetchNewPublished({ url, key, sinceIso, limit = 50 }) {
  const q = new URLSearchParams({
    kind: 'eq.post.published',
    created_at: `gt.${sinceIso}`,
    order: 'created_at.asc',
    limit: String(limit),
    select: 'id,created_at,profile_id,meta,title',
  })
  const res = await fetch(`${url}/rest/v1/notifications?${q}`, { headers: headers(key) })
  if (!res.ok) throw new Error(`supabase notifications ${res.status}: ${await res.text()}`)
  return res.json()
}

// Best-effort brand/profile name for a friendlier alert. Never throws.
const nameCache = new Map()
export async function brandName({ url, key, profileId }) {
  if (!profileId) return 'a brand'
  if (nameCache.has(profileId)) return nameCache.get(profileId)
  try {
    const q = new URLSearchParams({ id: `eq.${profileId}`, select: 'name,brand_name', limit: '1' })
    const res = await fetch(`${url}/rest/v1/profiles?${q}`, { headers: headers(key) })
    if (res.ok) {
      const rows = await res.json()
      const nm = rows?.[0]?.name || rows?.[0]?.brand_name || profileId
      nameCache.set(profileId, nm)
      return nm
    }
  } catch { /* fall through */ }
  return profileId
}
