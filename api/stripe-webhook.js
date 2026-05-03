// Stripe webhook handler with replay-safe idempotency.
// IMPORTANT: Vercel must NOT auto-parse the body for this route — we need the raw bytes
// to verify the signature. We turn off the parser via the config export below.

const { setCors, supaFetch } = require('./_lib/supabase')
const stripe = require('./_lib/stripe')
const { tierForPriceId, billingCycleForPriceId, profileLimitForTier } = require('./_lib/billing')

module.exports = async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).end()

  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set')
    return res.status(500).end()
  }

  // Read raw body
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const rawBody = Buffer.concat(chunks).toString('utf8')

  const sig = req.headers['stripe-signature']
  const verified = await stripe.verifyWebhookSignature(rawBody, sig, secret)
  if (!verified) {
    console.warn('[stripe-webhook] signature failed')
    return res.status(400).json({ error: 'Invalid signature' })
  }

  let event
  try {
    event = JSON.parse(rawBody)
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' })
  }

  // Idempotency: insert the event row, return early if it already exists.
  try {
    await supaFetch('stripe_events', {
      method: 'POST',
      body: { stripe_event_id: event.id, event_type: event.type, payload: event },
      prefer: 'return=minimal',
    })
  } catch (err) {
    if (err.status === 409 || (err.data?.code === '23505')) {
      // Already processed — ack to Stripe so they stop retrying.
      return res.status(200).json({ received: true, duplicate: true })
    }
    console.error('[stripe-webhook] insert failed', err)
    return res.status(500).json({ error: 'idempotency insert failed' })
  }

  let handlerError = null
  try {
    await routeEvent(event)
  } catch (err) {
    console.error(`[stripe-webhook] handler ${event.type} failed`, err)
    handlerError = err.message || String(err)
  }

  // Mark processed (or record error) so we have observability without re-querying Stripe.
  try {
    await supaFetch(`stripe_events?stripe_event_id=eq.${encodeURIComponent(event.id)}`, {
      method: 'PATCH',
      body: { processed_at: new Date().toISOString(), error: handlerError },
      prefer: 'return=minimal',
    })
  } catch {}

  return res.status(200).json({ received: true })
}

// Tell Vercel/Next we want the raw body. (Vercel respects this in serverless functions.)
module.exports.config = { api: { bodyParser: false } }

// ──────────────────────────────────────────────────────────────────────────
async function routeEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
      return onCheckoutCompleted(event.data.object)
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.trial_will_end':
      return upsertSubscription(event.data.object)
    case 'customer.subscription.deleted':
      return onSubscriptionDeleted(event.data.object)
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed':
      // Subscription status reflects this; just refresh from Stripe to be safe.
      if (event.data.object.subscription) {
        const sub = await stripe.retrieveSubscription(event.data.object.subscription)
        return upsertSubscription(sub)
      }
      return
    default:
      // Recorded in stripe_events; nothing to do.
      return
  }
}

async function findCustomerRowByStripeId(stripeCustomerId) {
  const rows = await supaFetch(
    `billing_customers?stripe_customer_id=eq.${encodeURIComponent(stripeCustomerId)}&select=*`
  )
  return rows?.[0] || null
}

async function onCheckoutCompleted(session) {
  // The subscription gets created right after; the subsequent
  // customer.subscription.created event will populate billing_subscriptions.
  // Here we only ensure the customer row is up to date.
  if (session.customer && session.customer_email) {
    const row = await findCustomerRowByStripeId(session.customer)
    if (row && !row.email) {
      await supaFetch(`billing_customers?id=eq.${row.id}`, {
        method: 'PATCH',
        body: { email: session.customer_email },
      })
    }
  }
}

async function upsertSubscription(sub) {
  const customerRow = await findCustomerRowByStripeId(sub.customer)
  if (!customerRow) {
    console.warn(`[stripe-webhook] no billing_customers row for stripe customer ${sub.customer}`)
    return
  }

  const priceId = sub.items?.data?.[0]?.price?.id
  const tier = tierForPriceId(priceId) || sub.metadata?.tier || 'solo_starter'
  const cycle = billingCycleForPriceId(priceId)
  const profileLimit = profileLimitForTier(tier)

  const row = {
    customer_id: customerRow.id,
    stripe_subscription_id: sub.id,
    stripe_price_id: priceId,
    tier,
    billing_cycle: cycle,
    status: sub.status,
    trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    current_period_start: sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : null,
    current_period_end:   sub.current_period_end   ? new Date(sub.current_period_end   * 1000).toISOString() : null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    profile_limit: profileLimit,
  }

  // Upsert by stripe_subscription_id
  const existing = await supaFetch(
    `billing_subscriptions?stripe_subscription_id=eq.${encodeURIComponent(sub.id)}&select=id`
  )
  if (existing && existing.length) {
    await supaFetch(`billing_subscriptions?id=eq.${existing[0].id}`, {
      method: 'PATCH',
      body: row,
    })
  } else {
    await supaFetch('billing_subscriptions', { method: 'POST', body: row })
  }
}

async function onSubscriptionDeleted(sub) {
  await supaFetch(
    `billing_subscriptions?stripe_subscription_id=eq.${encodeURIComponent(sub.id)}`,
    {
      method: 'PATCH',
      body: { status: 'canceled', canceled_at: new Date().toISOString() },
      prefer: 'return=minimal',
    }
  )
}
