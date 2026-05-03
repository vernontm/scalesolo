// Creates a Stripe Checkout Session for a new subscription.
// Body: { tier: 'solo_starter'|'solo_pro'|'solo_studio'|'founding', billing_cycle?: 'monthly'|'annual', success_url?, cancel_url? }
// Auth: requires Supabase JWT (the user signing up must already exist).

const { setCors, requireUser, supaFetch } = require('./_lib/supabase')
const stripe = require('./_lib/stripe')
const { TIERS, profileLimitForTier } = require('./_lib/billing')

const APP_URL = process.env.SCALESOLO_DOMAIN || process.env.FRONTEND_URL || 'https://scalesolo.app'

module.exports = async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const body = req.body || {}
    const tier = body.tier
    const cycle = body.billing_cycle || 'monthly'
    const def = TIERS[tier]
    if (!def) return res.status(400).json({ error: `Unknown tier: ${tier}` })

    // Founding tier: claim a spot atomically (returns false if cap hit).
    if (tier === 'founding') {
      const claim = await supaFetch('rpc/claim_founding_spot', { method: 'POST', body: {} })
      const claimed = Array.isArray(claim) ? claim[0] : claim
      if (claimed === false || claimed?.claim_founding_spot === false) {
        return res.status(409).json({ error: 'Founding member spots are sold out.' })
      }
    }

    const priceId = cycle === 'annual' ? def.annual_price_id : def.monthly_price_id
    if (!priceId) return res.status(400).json({ error: `No price configured for ${tier}/${cycle}` })

    // Find or create the billing customer.
    let customerRow
    const existing = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=*`)
    if (existing && existing.length) {
      customerRow = existing[0]
    } else {
      const created = await supaFetch('billing_customers', {
        method: 'POST',
        body: { user_id: auth.user.id, email: auth.user.email },
      })
      customerRow = Array.isArray(created) ? created[0] : created
    }

    // Create the Stripe customer if missing.
    if (!customerRow.stripe_customer_id) {
      const stripeCust = await stripe.createCustomer(
        { email: auth.user.email, metadata: { supabase_user_id: auth.user.id, scalesolo_customer_id: customerRow.id } },
        { idempotencyKey: `cust-${customerRow.id}` }
      )
      await supaFetch(`billing_customers?id=eq.${customerRow.id}`, {
        method: 'PATCH',
        body: { stripe_customer_id: stripeCust.id },
      })
      customerRow.stripe_customer_id = stripeCust.id
    }

    const session = await stripe.createCheckoutSession({
      mode: 'subscription',
      customer: customerRow.stripe_customer_id,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 3,
        metadata: { tier, billing_cycle: cycle, scalesolo_customer_id: customerRow.id },
      },
      success_url: body.success_url || `${APP_URL}/dashboard?welcome=1`,
      cancel_url:  body.cancel_url  || `${APP_URL}/pricing`,
      allow_promotion_codes: true,
      metadata: { tier, billing_cycle: cycle, scalesolo_customer_id: customerRow.id },
      // include profile_limit in metadata so the webhook can echo it onto the subscription row
      payment_method_collection: 'always',
    }, { idempotencyKey: `checkout-${customerRow.id}-${tier}-${cycle}-${Date.now()}` })

    return res.status(200).json({ url: session.url, session_id: session.id, profile_limit: profileLimitForTier(tier) })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, data: err.data })
  }
}
