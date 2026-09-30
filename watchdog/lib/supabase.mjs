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

/**
 * Posts the pipeline marked failed after `sinceIso` (by last_error_at),
 * oldest first. These are posts that did not go out (e.g. never submitted
 * to Upload-Post, or Upload-Post rejected them).
 * @returns {Promise<Array<{id,title,profile_id,platforms,last_error,last_error_at}>>}
 */
export async function fetchNewFailed({ url, key, sinceIso, limit = 50 }) {
  const q = new URLSearchParams({
    status: 'eq.failed',
    last_error_at: `gt.${sinceIso}`,
    order: 'last_error_at.asc',
    limit: String(limit),
    select: 'id,title,profile_id,platforms,last_error,last_error_at',
  })
  const res = await fetch(`${url}/rest/v1/content_scripts?${q}`, { headers: headers(key) })
  if (!res.ok) throw new Error(`supabase content_scripts ${res.status}: ${await res.text()}`)
  return res.json()
}

// Best-effort brand/profile name for a friendlier alert. Never throws.
// The real column is business_name (there is no name/brand_name column), so
// selecting the wrong ones used to 400 and fall back to the raw UUID.
const nameCache = new Map()
export async function brandName({ url, key, profileId }) {
  if (!profileId) return 'a brand'
  if (nameCache.has(profileId)) return nameCache.get(profileId)
  try {
    const q = new URLSearchParams({ id: `eq.${profileId}`, select: 'business_name', limit: '1' })
    const res = await fetch(`${url}/rest/v1/profiles?${q}`, { headers: headers(key) })
    if (res.ok) {
      const rows = await res.json()
      const nm = rows?.[0]?.business_name || profileId
      nameCache.set(profileId, nm)
      return nm
    }
  } catch { /* fall through */ }
  return profileId
}
