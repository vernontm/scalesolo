// GET /api/stripe-resolve-session?id=cs_xxx
//
// Anonymous helper used by /signup when a visitor returns from Stripe
// Checkout via the public-signup flow. Reads the Checkout Session,
// pulls the email + tier + customer id off it, and returns enough
// info for the signup page to pre-fill the email field, lock it, and
// resume the account-creation step.
//
// No auth — the session_id is the credential. Anyone with the id
// can resolve it (which is fine; the id rotates every checkout).

import { setCors } from './_lib/supabase.js'
import * as stripe from './_lib/stripe.js'
import { tierForPriceId } from './_lib/billing.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const sessionId = req.query.id
    if (!sessionId || !/^cs_/.test(sessionId)) {
      return res.status(400).json({ error: 'valid session id required' })
    }

    // Fetch the session with the customer + subscription expanded so
    // we can read the email + tier in one round trip.
    const session = await stripe.call('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=customer&expand[]=subscription`)
    if (!session) return res.status(404).json({ error: 'session not found' })

    const email = session?.customer_details?.email || session?.customer?.email || null
    const stripeCustomerId = typeof session.customer === 'string' ? session.customer : session?.customer?.id || null
    const subscriptionStatus = session?.subscription?.status || null
    const priceId = session?.subscription?.items?.data?.[0]?.price?.id || null
    const tier = tierForPriceId(priceId) || session?.metadata?.tier || null

    return res.status(200).json({
      email,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: typeof session.subscription === 'string'
        ? session.subscription
        : session?.subscription?.id || null,
      subscription_status: subscriptionStatus,
      tier,
      billing_cycle: session?.metadata?.billing_cycle || 'monthly',
      payment_status: session.payment_status,
      session_id: sessionId,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
