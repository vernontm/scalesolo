// POST /api/stripe-trial-checkout
// Returns: { url, session_id }
//
// Single-purpose checkout flow for the /faceless-brand ad landing.
// Creates an anonymous Stripe Checkout Session that:
//   1. Charges a one-time $1 activation fee TODAY — defined INLINE
//      via Stripe's `price_data` (no separate Stripe price needed).
//   2. Starts a 3-day trial on the Founding $79/mo subscription
//      (line item 2, trial_period_days = 3 in subscription_data).
//   3. Routes back to /login?stripe_session=… so the post-checkout
//      flow creates the Supabase account + links the Stripe customer
//      exactly like /api/stripe-checkout-public does.
//
// Only ONE Stripe env var required:
//   STRIPE_PRICE_FOUNDING — the recurring $79/mo price (already
//   wired in TIERS.founding.monthly_price_id).
//
// The $1 activation fee is built inline with `price_data` — Stripe
// generates an ad-hoc one-time price for that line item. No need to
// create / maintain a separate "trial" price in the dashboard.
// `trial_period_days` is set in subscription_data, which is the only
// way to do it for an anonymous (no-customer) checkout session.

import { setCors } from './_lib/supabase.js'
import * as stripe from './_lib/stripe.js'
import { profileLimitForTier } from './_lib/billing.js'

const APP_URL = process.env.SCALESOLO_DOMAIN || process.env.FRONTEND_URL || 'https://scalesolo.ai'

// $1 activation fee, in CENTS. Pulled to a constant so it's obvious
// at the top of the file and trivially editable if the offer ever
// becomes "$1 trial" / "$7 trial" / etc.
const TRIAL_ACTIVATION_CENTS = 100
const TRIAL_PERIOD_DAYS      = 3

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const foundingPriceId = process.env.STRIPE_PRICE_FOUNDING
    if (!foundingPriceId) {
      return res.status(500).json({ error: 'STRIPE_PRICE_FOUNDING not configured (the $79/mo recurring price)' })
    }

    const session = await stripe.createCheckoutSession(
      {
        mode: 'subscription',
        line_items: [
          // One-time $1 activation fee. Defined INLINE via price_data
          // so we don't have to create a separate price in the Stripe
          // dashboard. Stripe generates an ad-hoc one-time price for
          // this line item and charges it at checkout. The receipt
          // shows it as a separate line so the customer sees exactly
          // what they're paying for.
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: 'ScaleSolo · Trial activation',
                description: '3-day full-access trial of the Founding plan',
              },
              unit_amount: TRIAL_ACTIVATION_CENTS,
              // No `recurring` block → Stripe treats this as a
              // one-time line item, charged once at checkout.
            },
            quantity: 1,
          },
          // Recurring Founding price (existing). trial_period_days =
          // 3 on subscription_data below holds the recurring charge
          // until day 4, by which point the customer has had time to
          // use the product or cancel.
          { price: foundingPriceId, quantity: 1 },
        ],
        subscription_data: {
          trial_period_days: TRIAL_PERIOD_DAYS,
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
          trial_activation_cents: String(TRIAL_ACTIVATION_CENTS),
          trial_period_days: String(TRIAL_PERIOD_DAYS),
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
