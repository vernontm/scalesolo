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
  // Internal service-secret bypass — lets the Fly workflow worker
  // call Vercel APIs without a user session. The worker sends:
  //   x-internal-secret: <WORKFLOW_INTERNAL_SECRET>
  //   x-impersonate-user: <user_id>
  // Both must be present + the secret must match. We trust the
  // impersonate header only when the secret is correct, so it's
  // impossible to spoof from a normal client. The synthesized auth
  // object looks just like a real user session to downstream code.
  const internalSecret = process.env.WORKFLOW_INTERNAL_SECRET
  const claimedSecret = req.headers['x-internal-secret']
  const claimedUserId = req.headers['x-impersonate-user']
  if (internalSecret && claimedSecret === internalSecret && claimedUserId) {
    return {
      user: { id: String(claimedUserId), email: null, app_metadata: { internal: true } },
      token: null,
      internal: true,
    }
  }

  const { user, token } = await getUserFromRequest(req)
  if (!user || !user.id) {
    res.status(401).json({ error: 'Unauthorized' })
    return null
  }
  return { user, token }
}

// Per-warm-container cache for is_admin lookups. Saves a DB roundtrip
// on every /api/admin/* request when the same user makes back-to-back
// admin calls (loading the admin dashboard fans out 3-5 queries).
// 60-second TTL keeps the window short enough that an admin demoted
// in the dashboard loses access within a minute, without hammering
// user_profiles for every request.
const _adminCache = new Map()
const ADMIN_CACHE_TTL_MS = 60_000

function readAdminCache(userId) {
  const hit = _adminCache.get(userId)
  if (!hit) return undefined
  if (hit.expires < Date.now()) { _adminCache.delete(userId); return undefined }
  return hit.value
}
function writeAdminCache(userId, value) {
  _adminCache.set(userId, { value, expires: Date.now() + ADMIN_CACHE_TTL_MS })
  // Bound the cache so a long-running container can't grow it without
  // bound. ~500 distinct admins between cleanups is plenty.
  if (_adminCache.size > 500) {
    const now = Date.now()
    for (const [k, v] of _adminCache) if (v.expires < now) _adminCache.delete(k)
  }
}

// Admin gate. Three-layer check, fastest first:
//   1. JWT claim — auth.users.raw_app_meta_data.is_admin is mirrored
//      from user_profiles via DB trigger, so getUserFromRequest()
//      already has it. Zero DB hits when present.
//   2. Per-container cache — 60s TTL. Saves a hit when an admin makes
//      back-to-back calls and the JWT happens to lack the claim
//      (older sessions issued before the migration).
//   3. user_profiles fallback — service-role REST call on a true cache
//      miss. Result feeds the cache.
// Returns { user, token } on success, or null after writing the 401/403.
export async function requireAdmin(req, res) {
  const auth = await requireUser(req, res)
  if (!auth) return null
  // (1) JWT app_meta_data — Supabase puts this on the user payload.
  const claim = auth.user?.app_metadata?.is_admin
  if (claim === true) return auth
  if (claim === false) {
    // Explicit false in the JWT means we know the answer; trust it.
    res.status(403).json({ error: 'Forbidden: admin only' })
    return null
  }
  // (2) Cache.
  const cached = readAdminCache(auth.user.id)
  if (cached === true) return auth
  if (cached === false) {
    res.status(403).json({ error: 'Forbidden: admin only' })
    return null
  }
  // (3) DB fallback. Only hit on a session issued before the trigger
  // backfill ran.
  try {
    const rows = await supaFetch(`user_profiles?id=eq.${auth.user.id}&select=is_admin`)
    const isAdmin = !!rows?.[0]?.is_admin
    writeAdminCache(auth.user.id, isAdmin)
    if (!isAdmin) {
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

// UUID v4 / v1 / v5 — all 36-char canonical with hyphens. Refuses
// anything else so a hostile string in profileId can't slip extra
// PostgREST query params via &-injection (e.g. `id&select=*`).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s)
}

export async function assertProfileAccess(userId, profileId) {
  // Validate both ids — auth.user.id is always a UUID; profileId comes
  // from req.body / req.query and could be anything if a caller forgot
  // to validate. PostgREST tolerates non-UUIDs and 400s, but a
  // malicious string with `&` could attempt query-param injection.
  if (!isUuid(userId) || !isUuid(profileId)) {
    const err = new Error('Invalid id format')
    err.status = 400
    throw err
  }
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
