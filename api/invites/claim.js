// Claim pending board-editor invites for the signed-in user's email. Idempotent
// — called from AuthContext on every sign-in. Grants a profile_access row
// (role='contributor', allowed_pages=['board']) for each pending board_invites
// row matching the user's email, then marks it accepted. This is how a brand-new
// editor who clicked their magic link actually gets access.
import { setCors, requireUser, supaFetch, fmtErr } from '../_lib/supabase.js'

const ALLOWED_PAGES = ['board', 'payouts']
const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

async function authAdmin(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  if (!r.ok) throw new Error(`auth admin ${r.status}`)
  return r.json().catch(() => ({}))
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    const email = String(auth.user?.email || '').trim().toLowerCase()
    if (!email) return res.status(200).json({ claimed: 0 })
    const pending = await supaFetch(
      `board_invites?email=eq.${encodeURIComponent(email)}&status=eq.pending&select=id,profile_id,name`
    )
    if (!pending?.length) return res.status(200).json({ claimed: 0 })
    // Set the editor's display name from the invite if they don't have one yet
    // (so their name shows on cards + in the activity thread, not their email).
    const inviteName = pending.map((p) => p.name).find(Boolean) || null
    const hasName = auth.user.user_metadata?.full_name || auth.user.user_metadata?.name
    if (inviteName && !hasName) {
      try { await authAdmin(`users/${auth.user.id}`, { method: 'PUT', body: JSON.stringify({ user_metadata: { ...(auth.user.user_metadata || {}), full_name: inviteName } }) }) } catch { /* best-effort */ }
    }
    let claimed = 0
    for (const iv of pending) {
      try {
        await supaFetch('profile_access', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: { user_id: auth.user.id, profile_id: iv.profile_id, role: 'contributor', allowed_pages: ALLOWED_PAGES },
        })
        await supaFetch(`board_invites?id=eq.${iv.id}`, {
          method: 'PATCH', body: { status: 'accepted', accepted_at: new Date().toISOString() }, prefer: 'return=minimal',
        })
        claimed++
      } catch (e) { console.warn('[invites/claim] grant failed', iv.profile_id, e?.message) }
    }
    return res.status(200).json({ claimed })
  } catch (err) {
    return res.status(err.status || 500).json({ error: fmtErr(err) })
  }
}
