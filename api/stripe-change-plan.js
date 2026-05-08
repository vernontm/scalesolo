// POST /api/stripe-change-plan
// Body: { tier, billing_cycle: 'monthly' | 'annual' }
//
// Swap the user's active subscription onto the chosen tier+cycle. Stripe
// handles proration so an upgrade charges the prorated diff right away
// and a downgrade credits the remaining time on the old plan against
// the next invoice. The webhook reconciles credits / profile_limit on
// the next invoice.paid event — we don't try to do that here.
//
// Founding members can't change plans through this endpoint (their
// price is locked) — they get a 409 telling them to use the portal.

import { setCors, requireUser, supaFetch } from './_lib/supabase.js'
import * as stripe from './_lib/stripe.js'
import { TIERS } from './_lib/billing.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { tier, billing_cycle = 'monthly' } = req.body || {}
    const def = TIERS[tier]
    if (!def) return res.status(400).json({ error: `Unknown tier: ${tier}` })
    if (tier === 'founding') {
      return res.status(409).json({ error: 'Founding member spots are sold out — change plans from the portal if needed.' })
    }
    const cycle = billing_cycle === 'annual' ? 'annual' : 'monthly'
    const newPriceId = cycle === 'annual' ? def.annual_price_id : def.monthly_price_id
    if (!newPriceId) return res.status(400).json({ error: `No price configured for ${tier}/${cycle}` })

    // Look up the user's customer + active subscription. We always
    // store stripe_subscription_id on billing_customers when checkout
    // completes, so any active row is a single fetch.
    const rows = await supaFetch(
      `billing_customers?user_id=eq.${auth.user.id}&select=id,stripe_customer_id,stripe_subscription_id,tier,billing_cycle`
    )
    const customer = rows?.[0]
    if (!customer?.stripe_subscription_id) {
      return res.status(404).json({ error: 'No active subscription. Pick a plan from /pricing first.' })
    }
    if (customer.tier === tier && customer.billing_cycle === cycle) {
      return res.status(409).json({ error: 'You\'re already on that plan.' })
    }
    if (customer.tier === 'founding') {
      return res.status(409).json({ error: 'Founding members keep their lifetime lock — manage from the portal if you really want to change.' })
    }

    // Pull the current subscription so we have its line item ID. Stripe
    // requires the *item* id, not the subscription id, when swapping
    // prices. A normal scalesolo sub has exactly one item.
    const sub = await stripe.retrieveSubscription(customer.stripe_subscription_id)
    const item = sub?.items?.data?.[0]
    if (!item?.id) {
      return res.status(500).json({ error: 'Could not read current subscription items from Stripe.' })
    }

    // Detect direction so the response can echo it for the toast.
    const ORDER = ['solo_starter', 'solo_pro', 'solo_studio']
    const dir = ORDER.indexOf(tier) > ORDER.indexOf(customer.tier) ? 'upgrade' : 'downgrade'

    // Upgrade → prorate immediately so the user pays the diff right
    // now and gets the new credits on the next webhook. Downgrade →
    // also prorate so the user gets credit for unused time on the
    // higher plan.
    const updated = await stripe.updateSubscription(customer.stripe_subscription_id, {
      'items[0][id]':    item.id,
      'items[0][price]': newPriceId,
      proration_behavior: 'always_invoice',
      payment_behavior:   'default_incomplete',
      'metadata[tier]':           tier,
      'metadata[billing_cycle]':  cycle,
      'metadata[scalesolo_customer_id]': customer.id,
    }, { idempotencyKey: `change-plan-${customer.id}-${tier}-${cycle}-${Date.now()}` })

    // Soft-update our row so the UI reflects the change instantly.
    // The webhook will reconcile authoritatively (period dates, credit
    // grants, profile_limit) on the next invoice.paid event.
    try {
      await supaFetch(`billing_customers?id=eq.${customer.id}`, {
        method: 'PATCH',
        body: { tier, billing_cycle: cycle },
      })
    } catch {}

    return res.status(200).json({
      ok: true,
      direction: dir,
      tier,
      billing_cycle: cycle,
      subscription_status: updated?.status || sub?.status || null,
      latest_invoice: updated?.latest_invoice || null,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, data: err.data })
  }
}
