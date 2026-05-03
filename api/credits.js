// GET /api/credits — current balances + monthly_grant per pool for the signed-in user.
import { setCors, requireUser, supaFetch } from './_lib/supabase.js'
import { customerIdForUser, publicTopupCatalog } from './_lib/credits.js'

const POOLS = ['ai_tokens', 'video_units', 'voice_minutes']

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const customerId = await customerIdForUser(auth.user.id)
    if (!customerId) {
      // No customer row yet → no subscription → return empty pools.
      return res.status(200).json({
        customer_id: null,
        pools: Object.fromEntries(POOLS.map((p) => [p, { balance: 0, monthly_grant: 0, last_reset_at: null }])),
        topup_catalog: publicTopupCatalog(),
      })
    }

    const rows = await supaFetch(
      `credit_pools?customer_id=eq.${customerId}&select=pool_type,balance,monthly_grant,last_reset_at`
    )

    const byPool = {}
    for (const p of POOLS) byPool[p] = { balance: 0, monthly_grant: 0, last_reset_at: null }
    for (const r of rows || []) {
      byPool[r.pool_type] = {
        balance: Number(r.balance),
        monthly_grant: Number(r.monthly_grant),
        last_reset_at: r.last_reset_at,
      }
    }

    return res.status(200).json({
      customer_id: customerId,
      pools: byPool,
      topup_catalog: publicTopupCatalog(),
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
