// ScaleSolo serverless auth + Supabase REST helper.
// Standalone — no dependency on the legacy VTM helpers.

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const ANON_KEY = process.env.SUPABASE_ANON_KEY

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

function setCors(req, res) {
  const origin = req.headers.origin
  if (origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Client-Info')
}

function getBearer(req) {
  const h = req.headers.authorization || ''
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null
}

// Validates a Supabase JWT by calling the auth REST endpoint.
async function getUserFromRequest(req) {
  const token = getBearer(req)
  if (!token) return { user: null, token: null }
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: ANON_KEY,
      },
    })
    if (!resp.ok) return { user: null, token }
    const user = await resp.json()
    return { user, token }
  } catch {
    return { user: null, token }
  }
}

async function requireUser(req, res) {
  const { user, token } = await getUserFromRequest(req)
  if (!user || !user.id) {
    res.status(401).json({ error: 'Unauthorized' })
    return null
  }
  return { user, token }
}

// Generic supabase REST passthrough using the service key (server-side only).
// `path` example: 'profiles?id=eq.<uuid>&select=*'
async function supaFetch(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: options.prefer || 'return=representation',
    ...(options.headers || {}),
  }
  const resp = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
  })
  let data = null
  const text = await resp.text()
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!resp.ok) {
    const err = new Error(`supabase ${resp.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
    err.status = resp.status
    err.data = data
    throw err
  }
  return data
}

// Confirm the user has access to a profile via profile_access.
async function assertProfileAccess(userId, profileId) {
  const rows = await supaFetch(
    `profile_access?user_id=eq.${userId}&profile_id=eq.${profileId}&select=role`
  )
  if (!rows || rows.length === 0) {
    const err = new Error('Forbidden')
    err.status = 403
    throw err
  }
  return rows[0].role
}

module.exports = {
  setCors,
  requireUser,
  getUserFromRequest,
  supaFetch,
  assertProfileAccess,
}
