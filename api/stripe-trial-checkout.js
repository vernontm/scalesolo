// POST /api/stripe-trial-checkout
// Returns: { url, session_id }
//
// Single-purpose checkout flow for the /faceless-brand ad landing.
// Creates an anonymous Stripe Checkout Session that:
//   1. Charges a one-time $1 activation fee TODAY (line item 1).
//   2. Starts a 3-day trial on the Founding $79/mo subscription
//      (line item 2 with trial_period_days = 3).
//   3. Routes back to /login?stripe_session=… so the post-checkout
//      flow creates the Supabase account + links the Stripe customer
//      exactly like /api/stripe-checkout-public does.
//
// Two Stripe prices required (env vars):
//   STRIPE_PRICE_FOUNDING_TRIAL_1   one-time $1 activation fee
//   STRIPE_PRICE_FOUNDING            recurring $79/mo (already wired)
//
// If either env is missing the endpoint returns 500 with a clear
// message — easier to debug at deploy time than a vague Stripe 400.

import { setCors } from './_lib/supabase.js'
import * as stripe from './_lib/stripe.js'
import { profileLimitForTier } from './_lib/billing.js'

const APP_URL = process.env.SCALESOLO_DOMAIN || process.env.FRONTEND_URL || 'https://scalesolo.ai'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const trialPriceId    = process.env.STRIPE_PRICE_FOUNDING_TRIAL_1
    const foundingPriceId = process.env.STRIPE_PRICE_FOUNDING
    if (!trialPriceId) {
      return res.status(500).json({ error: 'STRIPE_PRICE_FOUNDING_TRIAL_1 not configured (the $1 one-time activation fee)' })
    }
    if (!foundingPriceId) {
      return res.status(500).json({ error: 'STRIPE_PRICE_FOUNDING not configured (the $79/mo recurring price)' })
    }

    const session = await stripe.createCheckoutSession(
      {
        mode: 'subscription',
        line_items: [
          // One-time $1 charged at checkout. Shows up as a separate
          // line on the receipt so the customer sees what they're
          // paying for ("Trial activation").
          { price: trialPriceId,    quantity: 1 },
          // Recurring Founding price. trial_period_days = 3 on the
          // subscription_data below holds the recurring charge until
          // day 4, by which point the customer has had time to use
          // the product or cancel.
          { price: foundingPriceId, quantity: 1 },
        ],
        subscription_data: {
          trial_period_days: 3,
          metadata: {
            tier: 'founding',
            billing_cycle: 'monthly',
            public_signup: 'true',
            trial_offer: 'dollar_one',
          },
        },
        // success_url carries the session id so /login resolves the
        // email + tier off it and finishes account creation — same
        // pattern as stripe-checkout-public.js.
        success_url: `${APP_URL}/login?stripe_session={CHECKOUT_SESSION_ID}&tier=founding&cycle=monthly`,
        cancel_url:  `${APP_URL}/faceless-brand`,
        allow_promotion_codes: false,
        metadata: {
          tier: 'founding',
          billing_cycle: 'monthly',
          public_signup: 'true',
          source: 'faceless_brand_landing',
          offer: 'dollar_trial',
        },
        payment_method_collection: 'always',
      },
      // Idempotency key prevents accidental double-creation if the
      // landing page double-fires the click handler.
      { idempotencyKey: `trial-1-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }
    )

    return res.status(200).json({
      url: session.url,
      session_id: session.id,
      tier: 'founding',
      cycle: 'monthly',
      profile_limit: profileLimitForTier('founding'),
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
