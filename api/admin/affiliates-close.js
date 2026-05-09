// /api/admin/affiliates-close — flip "pending" commissions to "approved"
// once they're past the refund window. Designed to run daily via Vercel
// Cron, but also callable manually by an admin from the AdminAffiliates
// page (returns the count moved).
//
// Auth: admin via JWT, OR a CRON_SECRET header for the Vercel scheduled
// invocation (no JWT available there).
//
// Refund window: invoices that survive 30 days without a charge.refunded
// are very unlikely to clawback. Anything older than that AND still
// status='pending' is safe to approve, which puts it on the admin's "Pay"
// button.

import { setCors, supaFetch } from '../_lib/supabase.js'

const REFUND_WINDOW_DAYS = 30

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  // Accept POST (admin button) and GET (Vercel Cron). 405 on anything else.
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Auth: either admin JWT (POST from the admin UI), or the cron secret
  // bearer token (Vercel Cron sets `Authorization: Bearer $CRON_SECRET`
  // automatically on scheduled invocations).
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '')
  const cronSecret = process.env.CRON_SECRET
  const isCron = !!(cronSecret && bearer && bearer === cronSecret)

  if (!isCron) {
    const { requireAdmin } = await import('../_lib/supabase.js')
    const auth = await requireAdmin(req, res)
    if (!auth) return
  }

  try {
    const cutoff = new Date(Date.now() - REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const ready = await supaFetch(
      `affiliate_commissions?status=eq.pending&invoice_paid_at=lt.${encodeURIComponent(cutoff)}&select=id`
    )
    if (!ready.length) {
      return res.status(200).json({ approved: 0, cutoff })
    }
    const ids = ready.map((r) => r.id)
    await supaFetch(
      `affiliate_commissions?id=in.(${ids.map((i) => encodeURIComponent(i)).join(',')})`,
      { method: 'PATCH', body: { status: 'approved' }, prefer: 'return=minimal' }
    )
    return res.status(200).json({ approved: ids.length, cutoff })
  } catch (err) {
    console.error('affiliates-close error:', err?.stack || err)
    return res.status(500).json({ error: err.message })
  }
}
