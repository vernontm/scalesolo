// /api/admin/users — admin-only user list + per-user actions.
//
//   GET ?limit=50&q=email-substring
//     → { users: [{ id, email, created_at, last_sign_in_at, is_admin,
//                   tier, status, brand_profiles, balances, total_spent_usd }] }
//   POST ?action=reset_password { user_id }
//     → sends Supabase password-recovery email via auth admin API
//   POST ?action=comp_credits { user_id, ai_tokens?, video_units? }
//     → grants the specified amounts to the user's customer credit pools
//
// Stripe coupon + subscription manipulation is intentionally NOT included
// here yet — it crosses the prohibited "modify subscription" line, so it
// should always go through the Stripe dashboard or a guarded ops script.

import { setCors, requireAdmin, supaFetch } from '../_lib/supabase.js'
import { grant } from '../_lib/credits.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

async function authAdmin(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  let body = null
  const text = await r.text()
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!r.ok) {
    const err = new Error(`auth admin ${r.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
    err.status = r.status
    throw err
  }
  return body
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireAdmin(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const limit = Math.min(Number(req.query.limit) || 50, 200)
      const q = (req.query.q || '').toString().trim().toLowerCase()
      // Supabase auth admin /users supports paging + email filter.
      const params = new URLSearchParams({ page: '1', per_page: String(limit) })
      const adminBody = await authAdmin(`users?${params.toString()}`)
      let users = Array.isArray(adminBody?.users) ? adminBody.users : []
      if (q) users = users.filter((u) => (u.email || '').toLowerCase().includes(q))

      // Hydrate billing + admin flag in batch.
      const ids = users.map((u) => u.id).filter(Boolean)
      const [adminRows, customers, profilesAccess] = await Promise.all([
        ids.length ? supaFetch(`user_profiles?id=in.(${ids.join(',')})&select=id,is_admin`) : [],
        ids.length ? supaFetch(`billing_customers?user_id=in.(${ids.join(',')})&select=id,user_id`) : [],
        ids.length ? supaFetch(`profile_access?user_id=in.(${ids.join(',')})&select=user_id,profile_id`) : [],
      ])
      const adminMap = new Map(adminRows.map((r) => [r.id, r.is_admin]))
      const customerMap = new Map(customers.map((c) => [c.user_id, c.id]))
      const profileCount = new Map()
      for (const a of profilesAccess) profileCount.set(a.user_id, (profileCount.get(a.user_id) || 0) + 1)

      const customerIds = customers.map((c) => c.id)
      const [subRows, poolRows] = await Promise.all([
        customerIds.length ? supaFetch(`billing_subscriptions?customer_id=in.(${customerIds.join(',')})&select=customer_id,tier,status`) : [],
        customerIds.length ? supaFetch(`credit_pools?customer_id=in.(${customerIds.join(',')})&select=customer_id,pool_type,balance`) : [],
      ])
      const subMap = new Map(subRows.map((s) => [s.customer_id, s]))
      const poolMap = new Map()
      for (const p of poolRows) {
        const acc = poolMap.get(p.customer_id) || {}
        acc[p.pool_type] = Number(p.balance) || 0
        poolMap.set(p.customer_id, acc)
      }

      const out = users.map((u) => {
        const customerId = customerMap.get(u.id)
        const sub = customerId ? subMap.get(customerId) : null
        const balances = customerId ? poolMap.get(customerId) || {} : {}
        return {
          id: u.id,
          email: u.email,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at,
          is_admin: !!adminMap.get(u.id),
          tier: sub?.tier || null,
          status: sub?.status || null,
          brand_profiles: profileCount.get(u.id) || 0,
          balances,
          customer_id: customerId || null,
        }
      }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

      return res.status(200).json({ users: out })
    }

    if (req.method === 'POST') {
      const action = req.query.action
      const { user_id } = req.body || {}
      if (!user_id) return res.status(400).json({ error: 'user_id required' })

      if (action === 'reset_password') {
        // Look up the user's email so we can send recovery via the standard
        // /auth/v1/recover endpoint (admin /generate_link returns a link
        // but doesn't email; this triggers the SMTP send).
        const userBody = await authAdmin(`users/${encodeURIComponent(user_id)}`)
        const email = userBody?.email
        if (!email) return res.status(404).json({ error: 'No email on file for that user' })
        const r = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
          method: 'POST',
          headers: { apikey: SERVICE_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        })
        if (!r.ok) {
          const t = await r.text().catch(() => '')
          return res.status(502).json({ error: `recover failed (${r.status}): ${t.slice(0, 200)}` })
        }
        return res.status(200).json({ ok: true, email })
      }

      if (action === 'comp_credits') {
        const customers = await supaFetch(`billing_customers?user_id=eq.${user_id}&select=id`)
        let customerId = customers?.[0]?.id
        // Auto-create a billing_customers row if missing — lets us comp
        // credits to users who haven't gone through checkout yet (free
        // trial signups, manually invited testers, etc.).
        if (!customerId) {
          const userBody = await authAdmin(`users/${encodeURIComponent(user_id)}`).catch(() => null)
          const email = userBody?.email || null
          const created = await supaFetch('billing_customers', {
            method: 'POST',
            body: { user_id, email },
          })
          const row = Array.isArray(created) ? created[0] : created
          customerId = row?.id
          if (!customerId) return res.status(500).json({ error: 'Failed to create billing customer' })
        }
        const aiTokens = Number(req.body?.ai_tokens) || 0
        const videoUnits = Number(req.body?.video_units) || 0
        if (aiTokens <= 0 && videoUnits <= 0) return res.status(400).json({ error: 'ai_tokens or video_units must be a positive number' })
        const ops = []
        if (aiTokens > 0)   ops.push(grant({ customerId, poolType: 'ai_tokens',   amount: aiTokens,   action: 'admin_comp', refId: auth.user.id, metadata: { reason: 'admin comp', granted_by: auth.user.id } }))
        if (videoUnits > 0) ops.push(grant({ customerId, poolType: 'video_units', amount: videoUnits, action: 'admin_comp', refId: auth.user.id, metadata: { reason: 'admin comp', granted_by: auth.user.id } }))
        await Promise.all(ops)
        return res.status(200).json({ ok: true, granted: { ai_tokens: aiTokens, video_units: videoUnits } })
      }

      return res.status(400).json({ error: `unknown action: ${action}` })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('admin/users error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
