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
    // charges it. payment_behavior='default_incomplete' returns the
    // subscription in `incomplete` state with a payment intent that
    // needs confirming — handles SCA / 3DS gracefully AND surfaces a
    // hosted invoice URL we redirect the user to when there's no card
    // on file yet (common when the trial signup skipped the card step).
    // The earlier 'allow_incomplete' was invalid for subscription update
    // (that's an invoice-only param) and made Stripe 400 silently.
    const updated = await stripe.updateSubscription(customer.stripe_subscription_id, {
      trial_end: 'now',
      proration_behavior: 'none',
      payment_behavior: 'default_incomplete',
      'expand[]': 'latest_invoice',
    }, { idempotencyKey: `end-trial-${customer.id}-${Date.now()}` })

    // After expand[]=latest_invoice, updated.latest_invoice is the full
    // invoice object (not just the id). Normalize the response so the
    // client always gets a hosted_invoice_url it can redirect to when
    // payment hasn't actually cleared yet (incomplete status, no card
    // on file, SCA needed, etc).
    const latestInvoice = updated?.latest_invoice
    const hostedInvoiceUrl =
      (typeof latestInvoice === 'object' && latestInvoice?.hosted_invoice_url) || null
    const needsPayment = updated?.status === 'incomplete'
      || updated?.status === 'past_due'
      || (typeof latestInvoice === 'object' && latestInvoice?.status === 'open')

    return res.status(200).json({
      ok: true,
      subscription_status: updated?.status || null,
      current_period_end: updated?.current_period_end || null,
      latest_invoice: latestInvoice,
      hosted_invoice_url: hostedInvoiceUrl,
      needs_payment: needsPayment,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, data: err.data })
  }
}
