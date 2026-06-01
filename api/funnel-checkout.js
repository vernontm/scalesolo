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
// /funnel/thank-you.html page which delivers the download / next step.
// Uses the same STRIPE_SECRET_KEY already wired for the subscription flow.

import { setCors } from './_lib/supabase.js'
import * as stripe from './_lib/stripe.js'

const APP_URL = process.env.SCALESOLO_DOMAIN || process.env.FRONTEND_URL || 'https://scalesolo.ai'

const PRODUCTS = {
  tripwire: {
    cents: 1700,
    name: 'Build Your AI Empire (Playbook)',
    desc: 'The faceless brand monetization playbook. Instant download.',
    cancel: '/funnel/tripwire.html',
  },
  dfy: {
    cents: 39700,
    name: 'Done-For-You Launch',
    desc: 'We build your faceless brand for you, end to end.',
    cancel: '/funnel/dfy.html',
  },
}

const BUMP = {
  cents: 900,
  name: 'Faceless Content Pack',
  desc: '50 ready-to-use outfits, settings, and poses (male & female).',
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

    const session = await stripe.createCheckoutSession(
      {
        mode: 'payment',
        line_items,
        success_url: `${APP_URL}/funnel/thank-you.html?product=${product}&bump=${wantBump ? 1 : 0}&session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}${p.cancel}`,
        allow_promotion_codes: false,
        metadata: { funnel_product: product, bump: wantBump ? '1' : '0', source: 'funnel' },
      },
      { idempotencyKey: `funnel-${product}-${wantBump ? 'b' : 'n'}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }
    )

    return res.status(200).json({ url: session.url, session_id: session.id })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
