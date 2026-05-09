// /api/admin/affiliates — admin-only management of the affiliate
// program. List enrolled affiliates, approve/promote/suspend, and
// roll pending commissions into payouts.
//
//   GET                                → list all affiliates with stats
//   POST ?action=set_status&id=…       → { status: 'approved'|'pending'|'suspended' }
//   POST ?action=set_tier&id=…         → { tier: 'starter'|'pro'|'elite' }
//   POST ?action=mark_paid&id=…        → { commission_ids?, all_pending?, external_ref? }
//                                          marks commissions paid + optional payout row
//   GET  ?action=commissions&id=…      → list this affiliate's commissions
//
// We don't push payouts to PayPal automatically — that's a money move
// that crosses the prohibited-actions line. Admin marks paid here after
// sending the PayPal manually.

import { setCors, requireAdmin, supaFetch } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireAdmin(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET' && req.query.action === 'commissions') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(
        `affiliate_commissions?affiliate_id=eq.${id}&select=*&order=invoice_paid_at.desc&limit=200`
      )
      return res.status(200).json({ commissions: rows })
    }

    if (req.method === 'GET') {
      const affs = await supaFetch('affiliates?select=*&order=created_at.desc')
      // Hydrate stats per affiliate.
      const ids = affs.map((a) => a.id)
      const inList = ids.length ? `(${ids.map((i) => encodeURIComponent(i)).join(',')})` : null
      const [refs, comms] = await Promise.all([
        ids.length ? supaFetch(`affiliate_referrals?affiliate_id=in.${inList}&select=affiliate_id,first_paid_at`) : [],
        ids.length ? supaFetch(`affiliate_commissions?affiliate_id=in.${inList}&select=affiliate_id,commission_cents,status`) : [],
      ])
      const refMap = new Map()
      for (const r of refs) {
        const cur = refMap.get(r.affiliate_id) || { total: 0, paying: 0 }
        cur.total += 1
        if (r.first_paid_at) cur.paying += 1
        refMap.set(r.affiliate_id, cur)
      }
      const commMap = new Map()
      for (const c of comms) {
        const cur = commMap.get(c.affiliate_id) || { total: 0, pending: 0, paid: 0 }
        const cents = Number(c.commission_cents) || 0
        cur.total += cents
        if (c.status === 'pending' || c.status === 'approved') cur.pending += cents
        else if (c.status === 'paid') cur.paid += cents
        commMap.set(c.affiliate_id, cur)
      }
      const out = affs.map((a) => ({
        ...a,
        stats: {
          referrals:                 refMap.get(a.id)?.total || 0,
          paying_referrals:          refMap.get(a.id)?.paying || 0,
          lifetime_commission_cents: commMap.get(a.id)?.total || 0,
          pending_commission_cents:  commMap.get(a.id)?.pending || 0,
          paid_commission_cents:     commMap.get(a.id)?.paid || 0,
        },
      }))
      return res.status(200).json({ affiliates: out })
    }

    if (req.method === 'POST') {
      const action = req.query.action
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })

      if (action === 'set_status') {
        const status = req.body?.status
        if (!['pending', 'approved', 'suspended'].includes(status)) {
          return res.status(400).json({ error: 'status must be pending|approved|suspended' })
        }
        const updates = { status }
        if (status === 'approved') updates.approved_at = new Date().toISOString()
        const updated = await supaFetch(`affiliates?id=eq.${id}`, { method: 'PATCH', body: updates })
        return res.status(200).json({ affiliate: Array.isArray(updated) ? updated[0] : updated })
      }

      if (action === 'set_tier') {
        const tier = req.body?.tier
        if (!['starter', 'pro', 'elite'].includes(tier)) {
          return res.status(400).json({ error: 'tier must be starter|pro|elite' })
        }
        const updated = await supaFetch(`affiliates?id=eq.${id}`, { method: 'PATCH', body: { tier } })
        return res.status(200).json({ affiliate: Array.isArray(updated) ? updated[0] : updated })
      }

      if (action === 'mark_paid') {
        // Resolve which commissions to mark paid.
        let commissionIds = Array.isArray(req.body?.commission_ids) ? req.body.commission_ids : null
        if (!commissionIds && req.body?.all_pending) {
          const rows = await supaFetch(
            `affiliate_commissions?affiliate_id=eq.${id}&status=in.(pending,approved)&select=id,commission_cents,currency`
          )
          commissionIds = rows.map((r) => r.id)
        }
        if (!commissionIds?.length) return res.status(400).json({ error: 'No commissions to mark paid' })

        // Sum to compute the payout total.
        const inList = `(${commissionIds.map((i) => encodeURIComponent(i)).join(',')})`
        const rows = await supaFetch(`affiliate_commissions?id=in.${inList}&select=commission_cents,currency`)
        const total = rows.reduce((acc, r) => acc + (Number(r.commission_cents) || 0), 0)
        const currency = rows[0]?.currency || 'usd'

        // Create the payout record + flip the commissions.
        const payouts = await supaFetch('affiliate_payouts', {
          method: 'POST',
          body: [{
            affiliate_id: id,
            total_cents: total,
            currency,
            status: 'sent',
            external_ref: req.body?.external_ref || null,
            notes: req.body?.notes || null,
            paid_at: new Date().toISOString(),
          }],
        })
        const payout = Array.isArray(payouts) ? payouts[0] : payouts

        await supaFetch(`affiliate_commissions?id=in.${inList}`, {
          method: 'PATCH',
          body: { status: 'paid', payout_id: payout.id },
          prefer: 'return=minimal',
        })
        return res.status(200).json({ payout, count: commissionIds.length, total_cents: total })
      }

      return res.status(400).json({ error: `unknown action: ${action}` })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('admin/affiliates error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
