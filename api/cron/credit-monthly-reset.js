// Daily cron: any pool whose last_reset_at < first day of current month gets
// granted its monthly_grant amount. Idempotent via credit_transactions
// (action='monthly_grant', ref_id=YYYY-MM).

import { supaFetch } from '../_lib/supabase.js'
import { grant } from '../_lib/credits.js'

export default async function handler(req, res) {
  // Vercel cron sends `?secret=<CRON_SECRET>`; reject otherwise.
  const expected = process.env.CRON_SECRET
  const got = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.query.secret
  if (expected && got !== expected) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)).toISOString()
    const refId = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`

    // Find all pools needing reset
    const due = await supaFetch(
      `credit_pools?last_reset_at=lt.${encodeURIComponent(monthStart)}&monthly_grant=gt.0&select=customer_id,pool_type,monthly_grant`
    )

    let granted = 0
    let skipped = 0
    for (const row of due || []) {
      const result = await grant({
        customerId: row.customer_id,
        poolType: row.pool_type,
        amount: Number(row.monthly_grant),
        action: 'monthly_grant',
        refId,
        metadata: { month: refId },
      })
      if (result === null) skipped++; else granted++
    }

    return res.status(200).json({
      month: refId,
      candidates: due?.length || 0,
      granted,
      skipped_already_applied: skipped,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
