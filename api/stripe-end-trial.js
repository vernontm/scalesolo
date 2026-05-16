// POST /api/stripe-end-trial
//
// Ends the current trial on the user's existing Stripe subscription
// immediately. Stripe charges the customer right away (the regular
// price for the full billing period, no proration needed since the
// trial wasn't billed). The webhook then fires customer.subscription.
// updated → trial_end transitions, which our handler treats as the
// "first paid period" and grants the full tier credits.
//
// Why a dedicated endpoint:
//   /api/stripe-checkout always sets trial_period_days=3, so it can't
//   be used to "skip trial" for someone who already has a subscription.
//   Re-running checkout would also create a duplicate subscription on
//   the same customer. The right Stripe primitive here is updating the
//   existing sub with trial_end='now'.

import { setCors, requireUser, supaFetch } from './_lib/supabase.js'
import * as stripe from './_lib/stripe.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const rows = await supaFetch(
      `billing_customers?user_id=eq.${auth.user.id}&select=id,stripe_customer_id,stripe_subscription_id,tier,billing_cycle`
    )
    const customer = rows?.[0]
    if (!customer?.stripe_subscription_id) {
      return res.status(404).json({ error: 'No active subscription found. Pick a plan from /pricing first.' })
    }

    const sub = await stripe.retrieveSubscription(customer.stripe_subscription_id)
    if (sub?.status !== 'trialing') {
      return res.status(409).json({
        error: `Subscription isn't on trial (currently ${sub?.status || 'unknown'}). Nothing to end.`,
        code: 'not_trialing',
        current_status: sub?.status || null,
      })
    }

    // trial_end='now' tells Stripe to terminate the trial this instant.
    // Stripe transitions the sub to active, generates an invoice for
    // the full first period, and (if a payment method is on file)
    // charges it. payment_behavior='allow_incomplete' lets the API
    // return successfully even if the charge needs SCA / 3DS — the
    // user gets sent to portal-or-checkout to complete payment in
    // that case (we surface latest_invoice in the response for the
    // client to redirect with).
    const updated = await stripe.updateSubscription(customer.stripe_subscription_id, {
      trial_end: 'now',
      proration_behavior: 'none',
      payment_behavior: 'allow_incomplete',
    }, { idempotencyKey: `end-trial-${customer.id}-${Date.now()}` })

    return res.status(200).json({
      ok: true,
      subscription_status: updated?.status || null,
      current_period_end: updated?.current_period_end || null,
      latest_invoice: updated?.latest_invoice || null,
      // If Stripe needs SCA the latest_invoice will be 'open' with a
      // hosted_invoice_url. Client should redirect there to confirm.
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, data: err.data })
  }
}
