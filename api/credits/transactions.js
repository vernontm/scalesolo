// GET /api/credits/transactions?pool=ai_tokens&limit=50&before=<iso>
import { setCors, requireUser, supaFetch } from '../_lib/supabase.js'
import { customerIdForUser } from '../_lib/credits.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const customerId = await customerIdForUser(auth.user.id)
    if (!customerId) return res.status(200).json({ transactions: [] })

    const pool   = req.query.pool
    const limit  = Math.min(parseInt(req.query.limit || '50', 10), 200)
    const before = req.query.before

    const params = new URLSearchParams({
      customer_id: `eq.${customerId}`,
      select: 'id,pool_type,delta,action,ref_table,ref_id,balance_after,profile_id,metadata,created_at',
      order: 'created_at.desc',
      limit: String(limit),
    })
    if (pool) params.set('pool_type', `eq.${pool}`)
    if (before) params.append('created_at', `lt.${before}`)

    const rows = await supaFetch(`credit_transactions?${params.toString()}`)
    return res.status(200).json({ transactions: rows || [] })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
