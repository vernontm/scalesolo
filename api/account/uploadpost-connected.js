// GET /api/account/uploadpost-connected?profile_id=<uuid>
//
// Returns which platforms (facebook / threads / twitter / instagram /
// tiktok / youtube / linkedin / pinterest / bluesky / reddit) are
// actually connected for this profile's Upload-Post user. The
// "Generate Content for the Month" modal calls this so platform
// checkboxes can be disabled / annotated when a platform isn't synced
// yet — saves users from generating posts that can't publish.
//
// Source of truth is Upload-Post's GET /api/uploadposts/users/{username}
// endpoint, which returns a `social_accounts` map. We normalize the
// keys to lowercase canonical platform names and return them as
// `connected_platforms`. Failures (network error, user not yet
// created, etc.) return an empty array rather than 500'ing — the UI
// can still let the user pick platforms manually.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { resolveUploadpostUser, uploadpostGetUserProfile } from '../_lib/uploadpost.js'

// Upload-Post sometimes returns keys like "Instagram" / "x" / "twitter" —
// fold them into our canonical set so the modal doesn't have to guess.
const PLATFORM_ALIASES = {
  x: 'twitter',
  twitter: 'twitter',
  instagram: 'instagram',
  facebook: 'facebook',
  threads: 'threads',
  tiktok: 'tiktok',
  youtube: 'youtube',
  linkedin: 'linkedin',
  pinterest: 'pinterest',
  bluesky: 'bluesky',
  reddit: 'reddit',
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const auth = await requireUser(req, res)
  if (!auth) return

  const profileId = String(req.query.profile_id || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profile_id required' })

  try {
    await assertProfileAccess(auth.user.id, profileId)

    const username = await resolveUploadpostUser(profileId)
    if (!username) {
      return res.status(200).json({
        username: null, connected_platforms: [], all_platforms: Object.values(PLATFORM_ALIASES),
      })
    }

    let profileData = null
    try {
      profileData = await uploadpostGetUserProfile(username)
    } catch (e) {
      // 404 = user not yet created on upload-post (auto-create happens
      // first time they publish). Treat as "nothing connected" rather
      // than an error so the modal still renders.
      console.warn(`[uploadpost-connected] lookup for ${username} failed: ${e?.message || e}`)
      return res.status(200).json({
        username, connected_platforms: [], all_platforms: Object.values(PLATFORM_ALIASES),
        warning: 'Upload-Post profile lookup failed — listing all platforms; verify connections in Upload-Post.',
      })
    }

    // Upload-Post returns slightly different shapes depending on which
    // version of their API was last touched. Try the documented
    // `social_accounts` map first, fall back to `profile.social_accounts`
    // or `platforms` array, then to an empty set.
    const socials = profileData?.social_accounts
      || profileData?.profile?.social_accounts
      || profileData?.user?.social_accounts
      || {}
    const platformsArray = profileData?.platforms || profileData?.connected_platforms || []

    const connectedSet = new Set()
    // Map form: { instagram: { username: "..." }, threads: {...} }
    if (socials && typeof socials === 'object' && !Array.isArray(socials)) {
      for (const [k, v] of Object.entries(socials)) {
        const canon = PLATFORM_ALIASES[k.toLowerCase()]
        if (canon && v) connectedSet.add(canon)
      }
    }
    // Array form: ["instagram", "threads"]
    for (const p of platformsArray) {
      const canon = PLATFORM_ALIASES[String(p).toLowerCase()]
      if (canon) connectedSet.add(canon)
    }

    return res.status(200).json({
      username,
      connected_platforms: Array.from(connectedSet),
      all_platforms: Object.values(PLATFORM_ALIASES),
    })
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || String(e) })
  }
}
