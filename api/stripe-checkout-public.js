// POST /api/stripe-checkout-public
// Body: { tier, billing_cycle?: 'monthly' | 'annual' }
// Returns: { url, session_id }
//
// Anonymous checkout — used when a visitor clicks a plan button on the
// public landing / pricing page before they have a Supabase account.
// Stripe Checkout collects their email natively. The success_url
// routes back to /signup?stripe_session=cs_xxx where the signup
// flow resolves the email + tier off the session and finishes the
// account creation.
//
// The webhook is the source of truth for billing_customer / subscription
// records — see api/stripe-webhook.js. We don't pre-create rows here.

import { setCors } from './_lib/supabase.js'
import * as stripe from './_lib/stripe.js'
import { TIERS, profileLimitForTier } from './_lib/billing.js'

const APP_URL = process.env.SCALESOLO_DOMAIN || process.env.FRONTEND_URL || 'https://scalesolo.ai'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { tier, billing_cycle = 'monthly' } = req.body || {}
    const def = TIERS[tier]
    if (!def) return res.status(400).json({ error: `Unknown tier: ${tier}` })

    const cycle = billing_cycle === 'annual' ? 'annual' : 'monthly'
    const priceId = cycle === 'annual' ? def.annual_price_id : def.monthly_price_id
    if (!priceId) return res.status(400).json({ error: `No ${cycle} price configured for ${tier}` })

    // Anonymous checkout — no `customer` field. Stripe creates a
    // Customer for us on payment + collects email via the native
    // email-collection step in Checkout. The signup page resolves
    // both off the session_id afterwards.
    const session = await stripe.createCheckoutSession({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // Force email collection so we can resolve it post-checkout.
      customer_creation: 'always',
      // Trial details match the logged-in flow — 3 days, card required.
      subscription_data: {
        trial_period_days: 3,
        metadata: { tier, billing_cycle: cycle, public_signup: 'true' },
      },
      // success_url carries the session id so /signup can read it and
      // pre-fill the email field. {CHECKOUT_SESSION_ID} is Stripe's
      // own placeholder which gets replaced server-side.
      success_url: `${APP_URL}/login?stripe_session={CHECKOUT_SESSION_ID}&tier=${encodeURIComponent(tier)}&cycle=${encodeURIComponent(cycle)}`,
      cancel_url:  `${APP_URL}/pricing`,
      allow_promotion_codes: true,
      metadata: { tier, billing_cycle: cycle, public_signup: 'true' },
      payment_method_collection: 'always',
    }, { idempotencyKey: `public-${tier}-${cycle}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })

    return res.status(200).json({
      url: session.url,
      session_id: session.id,
      tier,
      cycle,
      profile_limit: profileLimitForTier(tier),
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
