// GET /api/zapcap/templates
// Returns the live template catalog from ZapCap. Proxied so the API key
// never leaves the server. Cached in-memory per warm container for 5 min.

import { setCors, requireUser } from '../_lib/supabase.js'
import { zapcapListTemplates } from '../_lib/zapcap.js'

let _cache = null
let _cachedAt = 0
const TTL = 5 * 60 * 1000

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (_cache && Date.now() - _cachedAt < TTL) {
      return res.status(200).json({ templates: _cache, cached: true })
    }
    const data = await zapcapListTemplates()
    // ZapCap returns either a bare array or { templates: [...] } depending
    // on the endpoint version. Normalize.
    const templates = Array.isArray(data) ? data : (Array.isArray(data?.templates) ? data.templates : [])
    _cache = templates
    _cachedAt = Date.now()
    return res.status(200).json({ templates })
  } catch (e) {
    console.error('zapcap/templates error:', e?.stack || e)
    return res.status(e.status || 502).json({ error: e.message, response: e.response })
  }
}
