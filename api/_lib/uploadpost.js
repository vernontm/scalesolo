// Upload-Post API helper.
// Docs: https://docs.upload-post.com/api
//
// Auth: header `Authorization: Apikey YOUR_API_KEY`. Set UPLOADPOST_API_KEY
// in Vercel env. We use white-label "user profiles" so each ScaleSolo brand
// profile maps to its own Upload-Post sub-account; usernames are derived
// deterministically (no DB column needed).

const BASE = 'https://api.upload-post.com'

function key() {
  const k = process.env.UPLOADPOST_API_KEY
  if (!k) throw new Error('UPLOADPOST_API_KEY not configured')
  return k
}

// Stable, alphanum-safe username for a ScaleSolo brand profile. Upload-Post
// usernames must be unique account-wide, so we prefix with a workspace tag
// to dodge collisions across ScaleSolo accounts.
//
// `scalesolo_` + first 12 hex chars of the profile UUID is short, readable,
// and round-trippable. Profiles never get re-IDed so this stays stable.
export function deriveUploadPostUsername(profileId) {
  if (!profileId) return ''
  const hex = String(profileId).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12)
  return `scalesolo_${hex}`
}

// Honors profiles.uploadpost_user as a manual override so brands that
// already have a real Upload-Post account (e.g. Karahtx_, rayvaughnceo)
// can publish through their existing connected handles instead of a
// fresh whitelabel sub-account. Falls back to the auto-derived name.
//
// Imports supaFetch lazily so this module stays usable from contexts
// that don't have DB access (e.g. unit tests).
export async function resolveUploadpostUser(profileId) {
  if (!profileId) return ''
  try {
    const { supaFetch } = await import('./supabase.js')
    const rows = await supaFetch(`profiles?id=eq.${profileId}&select=uploadpost_user`)
    const explicit = rows?.[0]?.uploadpost_user
    if (explicit && explicit.trim()) return explicit.trim()
  } catch {}
  return deriveUploadPostUsername(profileId)
}

export async function uploadpost(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const init = {
    method,
    headers: { Authorization: `Apikey ${key()}`, Accept: 'application/json', ...headers },
  }
  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body  // let fetch set the multipart boundary
    } else {
      init.body = typeof body === 'string' ? body : JSON.stringify(body)
      if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json'
    }
  }
  const r = await fetch(`${BASE}${path}`, init)
  if (raw) return r
  const txt = await r.text()
  let data = null
  try { data = txt ? JSON.parse(txt) : {} } catch { data = { raw: txt } }
  if (!r.ok) {
    const msg = data?.message || data?.error || `Upload-Post ${path} → ${r.status}`
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
    err.status = r.status
    err.response = data
    throw err
  }
  return data
}

export async function uploadpostGetUserProfile(username) {
  return uploadpost(`/api/uploadposts/users/${encodeURIComponent(username)}`)
}

export async function uploadpostListUserProfiles() {
  return uploadpost('/api/uploadposts/users')
}

export async function uploadpostCreateUserProfile(username) {
  return uploadpost('/api/uploadposts/users', { method: 'POST', body: { username } })
}

export async function uploadpostGenerateJwt(username, opts = {}) {
  return uploadpost('/api/uploadposts/users/generate-jwt', {
    method: 'POST',
    body: { username, ...opts },
  })
}

// List scheduled jobs for an Upload-Post user. Used by the cleanup
// endpoint to reconcile what's actually queued on Upload-Post against
// what our content_scripts table thinks should be there. Returns the
// raw response; callers normalize the shape (Upload-Post historically
// returns either { posts: [...] } or { results: [...] } depending on
// the endpoint family).
export async function uploadpostListScheduled(username, opts = {}) {
  if (!username) return { posts: [] }
  // Default: scheduled-status posts. limit=200 covers any reasonable
  // brand's pending queue without paging.
  const qs = new URLSearchParams({ status: 'scheduled', limit: String(opts.limit || 200) })
  const data = await uploadpost(`/api/uploadposts/posts/${encodeURIComponent(username)}?${qs}`).catch((e) => {
    // Upload-Post sometimes 404s when there are no scheduled jobs on a
    // user; treat that as an empty list, not a hard failure.
    if (e.status === 404) return { posts: [] }
    throw e
  })
  return data || { posts: [] }
}

// Cancel a scheduled Upload-Post job. Fails soft on 404 (already fired or
// never existed) so callers can use this in cascade-delete paths without
// blocking the local delete.
export async function uploadpostCancelScheduled(jobId) {
  if (!jobId) return { ok: false, reason: 'no_job_id' }
  try {
    await uploadpost(`/api/uploadposts/schedule/${encodeURIComponent(jobId)}`, { method: 'DELETE' })
    return { ok: true }
  } catch (e) {
    if (e.status === 404) return { ok: false, reason: 'not_found', status: 404 }
    return { ok: false, reason: e.message, status: e.status }
  }
}

// Idempotent: returns the profile (creates first if missing).
export async function uploadpostEnsureUserProfile(username) {
  try {
    const data = await uploadpostGetUserProfile(username)
    if (data?.profile) return data.profile
  } catch (e) {
    if (e.status !== 404) throw e
  }
  const created = await uploadpostCreateUserProfile(username)
  return created.profile || { username, social_accounts: {} }
}
