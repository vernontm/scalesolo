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

// List scheduled jobs for the Upload-Post account associated with the
// current API key. Per the documented endpoint
// (https://docs.upload-post.com/api/schedule-posts):
//
//   GET /api/uploadposts/schedule
//   Authorization: Apikey <token>
//
// Returns an array of { job_id, scheduled_date, post_type, title,
// preview_url, profile_username }. NOTE the response does NOT include
// `request_id` — that field is only returned by the submission endpoint
// at schedule time. Callers that need to cancel a job MUST persist the
// job_id at submission and look up by that, not by request_id.
//
// The `username` argument is kept for backward compatibility with older
// call sites that scope by username — we filter the documented endpoint's
// global response by profile_username in JS so existing usage continues
// to work. Pass `''` / null to get every job on the account.
export async function uploadpostListScheduled(username, opts = {}) {
  const data = await uploadpost(`/api/uploadposts/schedule`).catch((e) => {
    if (e.status === 404) return []
    throw e
  })
  // Documented response is a bare JSON array. Be liberal in case
  // Upload-Post wraps it in {jobs: [...]} or {results: [...]} on
  // some accounts / API versions.
  const arr = Array.isArray(data)
    ? data
    : (Array.isArray(data?.jobs) ? data.jobs
      : Array.isArray(data?.posts) ? data.posts
      : Array.isArray(data?.results) ? data.results
      : Array.isArray(data?.data) ? data.data
      : [])
  const filtered = username
    ? arr.filter((j) => !j?.profile_username || String(j.profile_username) === String(username))
    : arr
  // Wrap in { posts } so existing callers that destructure raw.posts /
  // Array.isArray(raw) checks both keep working without edits.
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
