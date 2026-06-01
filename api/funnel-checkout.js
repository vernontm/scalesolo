// POST /api/funnel-checkout
// Body: { product: 'tripwire' | 'dfy', bump?: boolean }
// Returns: { url, session_id }
//
// One-time (mode:'payment') Stripe Checkout for the marketing funnel:
//   - tripwire: $17 "Build Your AI Empire" playbook
//   - bump:     +$9 "Faceless Content Pack" (only valid with tripwire)
//   - dfy:      $397 "Done-For-You Launch"
//
// Prices are defined INLINE via price_data, so there is nothing to create
// in the Stripe dashboard. On success, Stripe redirects to the static
// /welcome page which delivers the download / next step.
// Uses the same STRIPE_SECRET_KEY already wired for the subscription flow.

import { setCors } from './_lib/supabase.js'
import * as stripe from './_lib/stripe.js'

const APP_URL = process.env.SCALESOLO_DOMAIN || process.env.FRONTEND_URL || 'https://scalesolo.ai'

const PRODUCTS = {
  tripwire: {
    cents: 1700,
    name: 'Build Your AI Empire — The Faceless Brand Monetization Playbook',
    desc: 'The step-by-step playbook for turning a faceless AI page into real income: what to sell, how to grow an audience you own, and how to get paid. Instant digital download.',
    cancel: '/build-your-ai-empire',
  },
  dfy: {
    cents: 39700,
    name: 'Done-For-You Launch',
    desc: 'We build your faceless brand for you: a trained AI avatar, multiple looks, your brand voice, your first batch of ready-to-post videos, and your auto-posting workflow, handed off on a call. One-time setup service.',
    cancel: '/done-for-you',
  },
}

const BUMP = {
  cents: 900,
  name: 'Faceless Content Pack',
  desc: '50 ready-to-use outfit, environment, and pose references (male and female) so you can build your avatar looks in minutes instead of sourcing them yourself. Instant digital download.',
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const body = req.body || {}
    const product = (body.product || '').toString()
    const p = PRODUCTS[product]
    if (!p) return res.status(400).json({ error: 'Unknown product' })

    const wantBump = product === 'tripwire' && !!body.bump

    const line_items = [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: p.name, description: p.desc },
          unit_amount: p.cents,
        },
        quantity: 1,
      },
    ]
    if (wantBump) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: BUMP.name, description: BUMP.desc },
          unit_amount: BUMP.cents,
        },
        quantity: 1,
      })
    }

    // Where to send them after Stripe collects payment:
    // - tripwire → /oto?session=… (one-click upsell page for the $397 DFY)
    // - dfy direct → /welcome?product=dfy (no upsell to chain)
    // For tripwire we also pass setup_future_usage='off_session' so the
    // payment method is saved and the OTO endpoint can charge $397 with
    // a single click instead of re-collecting card details.
    const successPath = product === 'tripwire'
      ? `/oto?session={CHECKOUT_SESSION_ID}&bump=${wantBump ? 1 : 0}`
      : `/welcome?product=${product}&bump=${wantBump ? 1 : 0}&session={CHECKOUT_SESSION_ID}`

    const checkoutBody = {
      mode: 'payment',
      line_items,
      success_url: `${APP_URL}${successPath}`,
      cancel_url: `${APP_URL}${p.cancel}`,
      allow_promotion_codes: false,
      metadata: { funnel_product: product, bump: wantBump ? '1' : '0', source: 'funnel' },
    }
    if (product === 'tripwire') {
      // Save the card on the customer for the one-click OTO upsell.
      checkoutBody.payment_intent_data = { setup_future_usage: 'off_session' }
      // Force-create a Customer (Stripe usually does this for us in
      // mode:'payment' but we make it explicit so the OTO endpoint
      // can rely on session.customer being non-null).
      checkoutBody.customer_creation = 'always'
    }

    const session = await stripe.createCheckoutSession(
      checkoutBody,
      { idempotencyKey: `funnel-${product}-${wantBump ? 'b' : 'n'}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }
    )

    return res.status(200).json({ url: session.url, session_id: session.id })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
