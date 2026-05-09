// /api/affiliate/attribute — record that the authenticated user signed
// up via an affiliate's link. Called by the SPA right after signup,
// reading the ?ref=… code captured at landing time.
//
// Idempotent: refuses to overwrite an existing attribution. Refuses to
// self-attribute (the affiliate's own user_id can't refer themselves).

import { setCors, requireUser, supaFetch } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    // Prefer the explicit body code (the SPA sends one out of localStorage),
    // fall back to the scalesolo_ref cookie that Landing.jsx sets at click
    // time so attribution survives a localStorage wipe.
    let code = (req.body?.code || '').toString().trim().toLowerCase().slice(0, 64)
    if (!code) {
      const cookieHeader = req.headers?.cookie || ''
      const m = cookieHeader.match(/(?:^|;\s*)scalesolo_ref=([^;]+)/)
      if (m) code = decodeURIComponent(m[1]).toLowerCase().slice(0, 64)
    }
    if (!code) return res.status(400).json({ error: 'code required' })

    // Already attributed? Tell the client so it can stop retrying.
    const existing = await supaFetch(
      `affiliate_referrals?referred_user_id=eq.${auth.user.id}&select=id,affiliate_id`
    )
    if (existing.length) {
      return res.status(200).json({ attributed: true, referral: existing[0], existed: true })
    }

    const aff = await supaFetch(`affiliates?code=eq.${encodeURIComponent(code)}&select=id,user_id,status`)
    if (!aff.length) return res.status(404).json({ error: 'Unknown affiliate code' })
    const a = aff[0]
    if (a.user_id === auth.user.id) {
      return res.status(400).json({ error: 'Self-attribution not allowed' })
    }
    if (a.status === 'suspended') {
      return res.status(403).json({ error: 'Affiliate suspended' })
    }

    const inserted = await supaFetch('affiliate_referrals', {
      method: 'POST',
      body: [{
        affiliate_id: a.id,
        referred_user_id: auth.user.id,
      }],
    })
    return res.status(201).json({ attributed: true, referral: Array.isArray(inserted) ? inserted[0] : inserted })
  } catch (err) {
    // Unique-key violation = lost a race; treat as already attributed.
    if (err.status === 409 || err.data?.code === '23505') {
      return res.status(200).json({ attributed: true, existed: true })
    }
    console.error('affiliate/attribute error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
