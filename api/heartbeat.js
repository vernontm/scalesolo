// POST /api/heartbeat
// Body: { session_id?: string }
// Auth: optional. Signed-in users send a bearer token; anonymous
//       visitors (landing page, public preview, etc.) just send a
//       session_id from localStorage. Both paths upsert into
//       user_heartbeats so the admin presence widget reflects
//       TOTAL traffic, not just authenticated users.
//
// Returns: { ok: true, last_seen_at }
//
// One row per browser session (PK = session_id). user_id is filled in
// the moment that same session attaches an auth token, so we can still
// distinguish signed-in vs anon traffic later if we need to.

import { setCors, supaFetch } from './_lib/supabase.js'
import { createClient } from '@supabase/supabase-js'

// Soft auth: try to resolve the bearer token to a user. Failure is
// fine — anon visitors get a null user_id.
async function softAuthUserId(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL
    const ANON_KEY = process.env.SUPABASE_ANON_KEY
    if (!SUPABASE_URL || !ANON_KEY) return null
    const supa = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    })
    const { data } = await supa.auth.getUser()
    return data?.user?.id || null
  } catch {
    return null
  }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const body = req.body || {}
    const sessionId = (body.session_id || '').toString().trim().slice(0, 96)
    if (!sessionId) return res.status(400).json({ error: 'session_id required' })

    const userId = await softAuthUserId(req)
    const now = new Date().toISOString()

    // Upsert on session_id. resolution=merge-duplicates makes the
    // upsert idempotent on PK conflict. user_id gets patched the
    // first time a session signs in.
    const upsertBody = { session_id: sessionId, last_seen_at: now }
    if (userId) upsertBody.user_id = userId

    await supaFetch(`user_heartbeats?on_conflict=session_id`, {
      method: 'POST',
      body: upsertBody,
      prefer: 'return=minimal,resolution=merge-duplicates',
    })
    return res.status(200).json({ ok: true, last_seen_at: now })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
