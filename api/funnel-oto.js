// POST /api/funnel-oto
// Body: { session: <tripwire stripe session id>, accept: true }
// Returns: { ok: true, redirect } or { error, fallback_url? }
//
// Post-tripwire one-click upsell. The visitor just paid $17 for the
// playbook (a Stripe Checkout session with setup_future_usage='off_session',
// so the card is saved on the customer). Clicking "Yes, add the DFY" here
// hits Stripe off-session for $397 against that same payment method —
// no redirect to Stripe, no re-entering the card.
//
// If the bank requires 3-D Secure (PaymentIntent → requires_action), we
// fall back to a fresh Stripe Checkout for $397 so the visitor finishes
// the auth there. Conversion still completes, just one extra click.

import { setCors } from './_lib/supabase.js'
import * as stripe from './_lib/stripe.js'

const APP_URL = process.env.SCALESOLO_DOMAIN || process.env.FRONTEND_URL || 'https://scalesolo.ai'

const DFY = {
  cents: 39700,
  name: 'Done-For-You Launch',
  desc: 'We build your faceless brand for you: a trained AI avatar, multiple looks, your brand voice, your first batch of ready-to-post videos, and your auto-posting workflow, handed off on a call. One-time setup service.',
}

async function fetchSession(sessionId) {
  // Need payment_intent expanded so we can read the saved payment_method.
  return stripe.call('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent&expand[]=payment_intent.payment_method`)
}

async function createFallbackCheckout(customerId, sessionId) {
  // Bank wants 3DS — open a fresh Stripe Checkout so the visitor can
  // authenticate. We pre-bind to the same Customer so they don't have
  // to re-enter their email.
  return stripe.createCheckoutSession({
    mode: 'payment',
    customer: customerId,
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: DFY.name, description: DFY.desc },
        unit_amount: DFY.cents,
      },
      quantity: 1,
    }],
    success_url: `${APP_URL}/welcome?product=tripwire&upgraded=1&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/welcome?product=tripwire&session=${encodeURIComponent(sessionId)}`,
    metadata: { funnel_product: 'dfy', source: 'funnel_oto_fallback', oto_from_session: sessionId },
  }, { idempotencyKey: `oto-fb-${sessionId}` })
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const body = req.body || {}
    const sessionId = (body.session || '').toString()
    if (!sessionId.startsWith('cs_')) return res.status(400).json({ error: 'Missing or invalid session id.' })

    // Look up the original tripwire session and validate.
    const session = await fetchSession(sessionId)
    if (session.metadata?.funnel_product !== 'tripwire') {
      return res.status(400).json({ error: 'This upgrade is only available after a playbook purchase.' })
    }
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'The original payment is not complete yet. Please refresh in a moment.' })
    }
    const customerId = session.customer
    const paymentMethodId = session.payment_intent?.payment_method?.id || session.payment_intent?.payment_method
    if (!customerId || !paymentMethodId) {
      // Edge case: no saved card. Fall back to a fresh Checkout.
      const fb = await createFallbackCheckout(customerId, sessionId)
      return res.status(200).json({ ok: false, requires_checkout: true, fallback_url: fb.url })
    }

    // Off-session one-click charge. Idempotent on the session id so a
    // double-click can't double-charge — Stripe returns the same intent.
    let pi
    try {
      pi = await stripe.call('POST', '/payment_intents', {
        amount: DFY.cents,
        currency: 'usd',
        customer: customerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description: 'Done-For-You Launch',
        metadata: { funnel_product: 'dfy', source: 'funnel_oto', oto_from_session: sessionId },
      }, { idempotencyKey: `oto-${sessionId}` })
    } catch (err) {
      // 3DS / authentication required → fall back to Checkout.
      const code = err?.data?.error?.code
      if (code === 'authentication_required' || code === 'requires_action' || err?.status === 402) {
        const fb = await createFallbackCheckout(customerId, sessionId)
        return res.status(200).json({ ok: false, requires_checkout: true, fallback_url: fb.url })
      }
      throw err
    }

    if (pi.status === 'succeeded') {
      return res.status(200).json({ ok: true, redirect: `/welcome?product=tripwire&upgraded=1&session=${encodeURIComponent(sessionId)}` })
    }
    if (pi.status === 'requires_action' || pi.status === 'requires_payment_method') {
      const fb = await createFallbackCheckout(customerId, sessionId)
      return res.status(200).json({ ok: false, requires_checkout: true, fallback_url: fb.url })
    }
    return res.status(200).json({ ok: true, redirect: `/welcome?product=tripwire&upgraded=1&session=${encodeURIComponent(sessionId)}` })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Charge failed.' })
  }
}
