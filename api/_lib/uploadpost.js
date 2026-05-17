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

// List scheduled jobs for an Upload-Post sub-user.
//
// Empirically confirmed via the master Apikey: Upload-Post's documented
// endpoint (GET /api/uploadposts/schedule) returns ALL jobs the API-key
// holder has visibility into — including whitelabel sub-users — under
// the key `scheduled_posts`. Not `posts`, not a bare array as the docs
// suggest. We filter to the requested username in JS.
//
// The previously-tried per-username endpoint (/api/uploadposts/posts/
// <username>) 404s and is not a real route anymore.
export async function uploadpostListScheduled(username, opts = {}) {
  if (!username) return { posts: [] }
  const raw = await uploadpost(`/api/uploadposts/schedule`).catch((e) => {
    if (e.status === 404) return null
    throw e
  })
  // Be liberal in case Upload-Post changes the wrapper key. Try every
  // shape we've ever seen them ship, including the actual one
  // (scheduled_posts) that the master Apikey returns today.
  const arr = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.scheduled_posts) ? raw.scheduled_posts
      : Array.isArray(raw?.posts) ? raw.posts
      : Array.isArray(raw?.jobs) ? raw.jobs
      : Array.isArray(raw?.results) ? raw.results
      : Array.isArray(raw?.data) ? raw.data
      : [])
  const filtered = arr.filter((j) => !j?.profile_username || String(j.profile_username) === String(username))
  return { posts: filtered }
}

// Cancel a scheduled Upload-Post job by its INTERNAL job_id (NOT request_id).
// Upload-Post's DELETE endpoint keys off job_id; request_id is the public
// handle we store in content_scripts. If you only have a request_id, use
// uploadpostCancelByRequestId() — it does the request_id → job_id lookup
// for you via the list endpoint.
// Fails soft on 404 (already fired or never existed) so callers can use
// this in cascade-delete paths without blocking the local delete.
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

// LEGACY — kept for rows submitted before content_scripts.uploadpost_job_id
// existed. The documented list endpoint
// (https://docs.upload-post.com/api/schedule-posts) does NOT return
// `request_id`, only `job_id`. So this lookup is best-effort against
// non-documented fields some Upload-Post API versions historically
// included. New rows save job_id at submission time and skip this
// path entirely — see uploadpostCancelScheduled.
export async function uploadpostJobIdForRequestId(username, requestId) {
  if (!username || !requestId) return null
  const raw = await uploadpostListScheduled(username).catch(() => ({ posts: [] }))
  const jobs = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.posts) ? raw.posts
      : Array.isArray(raw?.results) ? raw.results
      : Array.isArray(raw?.data) ? raw.data
      : [])
  for (const j of jobs) {
    const rid = j?.request_id || j?.id || j?.requestId || j?.upload_id
    if (rid && String(rid) === String(requestId)) {
      return j?.job_id || j?.jobId || null
    }
  }
  return null
}

// LEGACY cancel-by-request_id. New rows persist uploadpost_job_id at
// submission and cancel directly via uploadpostCancelScheduled(jobId).
// This path remains only for rows scheduled before that column existed
// — and it's structurally limited because the documented list endpoint
// no longer exposes request_id, so most lookups will fall through to
// not_found. Callers should prefer uploadpostCancelScheduled(job_id)
// whenever the row has a stored job_id.
export async function uploadpostCancelByRequestId(username, requestId) {
  if (!username) return { ok: false, reason: 'no_username' }
  if (!requestId) return { ok: false, reason: 'no_request_id' }
  const jobId = await uploadpostJobIdForRequestId(username, requestId)
  if (!jobId) return { ok: false, reason: 'not_found', status: 404 }
  return uploadpostCancelScheduled(jobId)
}

// Find Upload-Post's internal job_id by matching the row's scheduled
// time + title against the documented list endpoint. Used as a
// fallback for legacy rows that have a uploadpost_request_id but no
// uploadpost_job_id stored. The documented list endpoint returns
// only job_id / scheduled_date / title — no request_id — so matching
// by time + title is the only way to recover the right job for
// cancellation on those rows.
//
// Tolerance: ±90 seconds on scheduled_date (Upload-Post and our DB
// can drift by a few seconds on round-trip); exact-prefix on title
// (40-char case-insensitive) when both sides have a title. Returns
// null when no job matches.
export async function uploadpostJobIdViaScheduleMatch(username, { scheduled_iso, title }) {
  if (!username || !scheduled_iso) return null
  const targetMs = Date.parse(scheduled_iso)
  if (!Number.isFinite(targetMs)) return null
  const targetTitle = (title || '').trim().toLowerCase().slice(0, 40)
  const raw = await uploadpostListScheduled(username).catch(() => ({ posts: [] }))
  const jobs = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.posts) ? raw.posts
      : Array.isArray(raw?.results) ? raw.results
      : Array.isArray(raw?.data) ? raw.data
      : [])
  for (const j of jobs) {
    if (!j?.job_id) continue
    const jobMs = Date.parse(j.scheduled_date || j.scheduled_at || '')
    if (!Number.isFinite(jobMs)) continue
    if (Math.abs(jobMs - targetMs) > 90_000) continue
    if (targetTitle && j.title) {
      const jt = String(j.title).trim().toLowerCase().slice(0, 40)
      if (jt !== targetTitle) continue
    }
    return j.job_id
  }
  return null
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
