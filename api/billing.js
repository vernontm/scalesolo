import { setCors, requireUser, supaFetch } from './_lib/supabase.js'
import { TIERS } from './_lib/billing.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const cust = await supaFetch(
      `billing_customers?user_id=eq.${auth.user.id}&select=id,stripe_customer_id,email`
    )
    const customer = cust?.[0] || null

    let subscription = null
    if (customer) {
      const subs = await supaFetch(
        `billing_subscriptions?customer_id=eq.${customer.id}&order=created_at.desc&limit=1&select=*`
      )
      subscription = subs?.[0] || null
    }

    const catalog = Object.fromEntries(
      Object.entries(TIERS).map(([k, v]) => [k, {
        name: v.name,
        profile_limit: v.profile_limit,
        monthly_usd: v.monthly_usd,
        annual_usd: v.annual_usd,
        credits: v.credits,
        description: v.description,
        lifetime_lock: !!v.lifetime_lock,
      }])
    )

    return res.status(200).json({
      customer,
      subscription,
      catalog,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
