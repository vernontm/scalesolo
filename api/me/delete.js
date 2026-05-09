// /api/me/delete — account deletion (GDPR-friendly self-serve).
// POST { confirm: 'DELETE' } → deletes the user's content + auth account.
//
// Refuses without the literal string 'DELETE' as confirmation so a CSRF
// poke or accidental click from the UI can't wipe an account. Cascades
// in the simplest order: per-profile tables first, then profile_access,
// then auth user (which also drops user_profiles via FK cascade if set
// up that way; otherwise we delete that row explicitly).
//
// Stripe subscriptions are NOT cancelled automatically — that's a
// prohibited action per project safety rules. The response message tells
// the user to cancel in Stripe separately so they don't get billed.

import { setCors, requireUser, supaFetch } from '../_lib/supabase.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  const confirm = req.body?.confirm
  if (confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Confirmation required. POST { confirm: "DELETE" } to proceed.' })
  }
  const userId = auth.user.id

  try {
    // Resolve profiles owned by this user so we can drop their per-profile
    // rows. Profiles shared via profile_access where the caller isn't the
    // owner are intentionally left alone — only their access row gets
    // dropped below.
    const access = await supaFetch(`profile_access?user_id=eq.${userId}&select=profile_id,role`)
    const ownedIds = access.filter((a) => a.role === 'owner').map((a) => a.profile_id)
    const inList = (arr) => arr.length ? `(${arr.map((id) => encodeURIComponent(id)).join(',')})` : null

    if (ownedIds.length) {
      await Promise.all([
        supaFetch(`content_scripts?profile_id=in.${inList(ownedIds)}`,    { method: 'DELETE', prefer: 'return=minimal' }),
        supaFetch(`avatar_renders?profile_id=in.${inList(ownedIds)}`,     { method: 'DELETE', prefer: 'return=minimal' }).catch(() => {}),
        supaFetch(`avatar_looks?profile_id=in.${inList(ownedIds)}`,       { method: 'DELETE', prefer: 'return=minimal' }).catch(() => {}),
        supaFetch(`avatars?profile_id=in.${inList(ownedIds)}`,            { method: 'DELETE', prefer: 'return=minimal' }),
        supaFetch(`spaces?profile_id=in.${inList(ownedIds)}`,             { method: 'DELETE', prefer: 'return=minimal' }),
        supaFetch(`profile_access?profile_id=in.${inList(ownedIds)}`,     { method: 'DELETE', prefer: 'return=minimal' }),
      ])
      await supaFetch(`profiles?id=in.${inList(ownedIds)}`, { method: 'DELETE', prefer: 'return=minimal' })
    }

    // Drop any remaining shared-access rows for this user, plus their
    // notifications and user_profiles bookkeeping.
    await Promise.all([
      supaFetch(`profile_access?user_id=eq.${userId}`, { method: 'DELETE', prefer: 'return=minimal' }).catch(() => {}),
      supaFetch(`notifications?user_id=eq.${userId}`,  { method: 'DELETE', prefer: 'return=minimal' }).catch(() => {}),
      supaFetch(`user_profiles?id=eq.${userId}`,       { method: 'DELETE', prefer: 'return=minimal' }).catch(() => {}),
    ])

    // Finally, drop the auth user. After this the JWT becomes invalid.
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      return res.status(502).json({ error: `auth delete failed (${r.status}): ${t.slice(0, 200)}` })
    }

    return res.status(200).json({
      ok: true,
      note: 'Account and content deleted. If you have an active Stripe subscription, cancel it in Stripe (or your billing portal) so you stop being charged.',
    })
  } catch (err) {
    console.error('me/delete error:', err?.stack || err)
    return res.status(500).json({ error: err.message })
  }
}
