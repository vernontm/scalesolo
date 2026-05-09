// ScaleSolo serverless auth + Supabase REST helper.
// Standalone — no dependency on the legacy VTM helpers.

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const ANON_KEY = process.env.SUPABASE_ANON_KEY

// CORS allowlist. Empty env → fallback to the production origin + localhost
// dev only. Previously empty meant "reflect any origin with credentials"
// which is a credentials-leak vector — never reflect arbitrary origins.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://scalesolo.vercel.app',
  'https://scalesolo.ai',
  'https://www.scalesolo.ai',
  'http://localhost:5173',
  'http://localhost:4173',
]
const ENV_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const ALLOWED_ORIGINS = ENV_ORIGINS.length ? ENV_ORIGINS : DEFAULT_ALLOWED_ORIGINS

// Vercel preview deployments live at <branch>-<hash>-<scope>.vercel.app — we
// allow any *.vercel.app sibling of our prod app rather than enumerating
// every preview host. Tighten if you need stricter prod-only.
function isAllowedOrigin(origin) {
  if (!origin) return false
  if (ALLOWED_ORIGINS.includes(origin)) return true
  try {
    const u = new URL(origin)
    if (u.hostname.endsWith('.vercel.app')) return true
  } catch {}
  return false
}

export function setCors(req, res) {
  const origin = req.headers.origin
  if (isAllowedOrigin(origin)) {
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

export async function getUserFromRequest(req) {
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

export async function requireUser(req, res) {
  const { user, token } = await getUserFromRequest(req)
  if (!user || !user.id) {
    res.status(401).json({ error: 'Unauthorized' })
    return null
  }
  return { user, token }
}

// Admin gate. Resolves the auth user, then checks the user_profiles
// row's is_admin flag via the service-role REST call (bypasses RLS so
// the API can verify admin status regardless of who's reading).
// Returns { user, token } on success, or null after writing the
// 401/403 response.
export async function requireAdmin(req, res) {
  const auth = await requireUser(req, res)
  if (!auth) return null
  try {
    const rows = await supaFetch(`user_profiles?id=eq.${auth.user.id}&select=is_admin`)
    if (!rows?.[0]?.is_admin) {
      res.status(403).json({ error: 'Forbidden: admin only' })
      return null
    }
    return auth
  } catch (e) {
    res.status(500).json({ error: 'Admin check failed' })
    return null
  }
}

export async function supaFetch(path, options = {}) {
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

export async function assertProfileAccess(userId, profileId) {
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
