// /api/affiliate — user-facing affiliate dashboard endpoint.
//
//   GET                          → my affiliate state (or { eligible: true } if not yet enrolled)
//   POST ?action=apply           → enroll (status='pending' until admin approves)
//   POST ?action=update          → patch paypal_email / display_name on my own row
//
// Tier promotion + status changes go through /api/admin/affiliates so
// regular users can't self-promote.

import { setCors, requireUser, supaFetch } from './_lib/supabase.js'
import { AFFILIATE_TIERS, generateAffiliateCode, affiliateLink } from './_lib/affiliate.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const rows = await supaFetch(`affiliates?user_id=eq.${auth.user.id}&select=*`)
      const aff = rows[0] || null
      if (!aff) {
        return res.status(200).json({
          enrolled: false,
          tiers: AFFILIATE_TIERS,
        })
      }
      // Hydrate stats: referral count, paying count, lifetime + pending commission.
      const [referrals, commissions] = await Promise.all([
        supaFetch(`affiliate_referrals?affiliate_id=eq.${aff.id}&select=id,signed_up_at,first_paid_at`),
        supaFetch(`affiliate_commissions?affiliate_id=eq.${aff.id}&select=commission_cents,status,invoice_paid_at,gross_amount_cents&order=invoice_paid_at.desc&limit=200`),
      ])
      const payingCount = referrals.filter((r) => !!r.first_paid_at).length
      let lifetime = 0, pending = 0, paid = 0
      for (const c of commissions) {
        const cents = Number(c.commission_cents) || 0
        lifetime += cents
        if (c.status === 'pending' || c.status === 'approved') pending += cents
        else if (c.status === 'paid') paid += cents
      }
      return res.status(200).json({
        enrolled: true,
        affiliate: aff,
        link: affiliateLink(aff.code),
        tiers: AFFILIATE_TIERS,
        stats: {
          referrals: referrals.length,
          paying_referrals: payingCount,
          lifetime_commission_cents: lifetime,
          pending_commission_cents: pending,
          paid_commission_cents: paid,
        },
        recent_commissions: commissions.slice(0, 20),
      })
    }

    if (req.method === 'POST') {
      const action = req.query.action
      const existing = await supaFetch(`affiliates?user_id=eq.${auth.user.id}&select=*`)
      const cur = existing[0] || null

      if (action === 'apply') {
        if (cur) return res.status(400).json({ error: 'Already enrolled', affiliate: cur })
        const displayName = (req.body?.display_name || '').toString().trim().slice(0, 80)
        const paypalEmail = (req.body?.paypal_email || '').toString().trim().slice(0, 200)
        const code = await generateAffiliateCode({ user: auth.user, displayName })
        const inserted = await supaFetch('affiliates', {
          method: 'POST',
          body: [{
            user_id: auth.user.id,
            code,
            display_name: displayName || null,
            paypal_email: paypalEmail || null,
            tier: 'starter',
            status: 'pending',
          }],
        })
        const row = Array.isArray(inserted) ? inserted[0] : inserted
        return res.status(201).json({ affiliate: row, link: affiliateLink(row.code) })
      }

      if (action === 'update') {
        if (!cur) return res.status(404).json({ error: 'Not enrolled' })
        const ALLOWED = new Set(['paypal_email', 'display_name'])
        const updates = {}
        for (const [k, v] of Object.entries(req.body || {})) {
          if (ALLOWED.has(k) && (typeof v === 'string' || v === null)) {
            updates[k] = v ? String(v).slice(0, 200) : null
          }
        }
        if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' })
        const updated = await supaFetch(`affiliates?id=eq.${cur.id}`, { method: 'PATCH', body: updates })
        return res.status(200).json({ affiliate: Array.isArray(updated) ? updated[0] : updated })
      }

      return res.status(400).json({ error: `unknown action: ${action}` })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('affiliate error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
