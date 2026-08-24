// Claim pending board-editor invites for the signed-in user's email. Idempotent
// — called from AuthContext on every sign-in. Grants a profile_access row
// (role='contributor', allowed_pages=['board']) for each pending board_invites
// row matching the user's email, then marks it accepted. This is how a brand-new
// editor who clicked their magic link actually gets access.
import { setCors, requireUser, supaFetch, fmtErr } from '../_lib/supabase.js'

const ALLOWED_PAGES = ['board']

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
      `board_invites?email=eq.${encodeURIComponent(email)}&status=eq.pending&select=id,profile_id`
    )
    if (!pending?.length) return res.status(200).json({ claimed: 0 })
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
