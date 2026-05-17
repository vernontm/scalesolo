// POST /api/heartbeat
// Body: {}                                 (auth-only — user inferred from JWT)
// Returns: { ok: true, last_seen_at }
//
// Lightweight "I'm here" ping. The signed-in client posts on a 30s
// tick + on page focus / visibility change. Powers the admin
// dashboard's "Active now" + "Today" counters via /api/admin/presence.
//
// One row per user — upsert on every heartbeat. We only need the
// most-recent last_seen_at, not a history. Idempotent + cheap.

import { setCors, requireUser, supaFetch } from './_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const now = new Date().toISOString()
    // Upsert via PostgREST's `on_conflict=user_id`. Forces a refresh
    // of last_seen_at every call. resolution=merge-duplicates makes
    // the upsert idempotent on PK conflict.
    await supaFetch(`user_heartbeats?on_conflict=user_id`, {
      method: 'POST',
      body: { user_id: auth.user.id, last_seen_at: now },
      prefer: 'return=minimal,resolution=merge-duplicates',
    })
    return res.status(200).json({ ok: true, last_seen_at: now })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
