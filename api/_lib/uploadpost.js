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
