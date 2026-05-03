// Stripe webhook handler — Edge Runtime so we get raw body cleanly via req.text().
// Node Functions on Vercel auto-parse req.body, breaking signature verification.

import { tierForPriceId, billingCycleForPriceId, profileLimitForTier } from './_lib/billing.js'

export const config = { runtime: 'edge' }

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY

async function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const [k, ...v] = p.split('=')
      return [k, v.join('=')]
    })
  )
  const t = parts.t, v1 = parts.v1
  if (!t || !v1) return false
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(`${t}.${rawBody}`))
  const expected = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
  if (expected.length !== v1.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i)
  return diff === 0
}

async function supa(path, options = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await resp.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!resp.ok) {
    const err = new Error(`supa ${resp.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
    err.status = resp.status
    err.data = data
    throw err
  }
  return data
}

async function stripeGet(path) {
  const resp = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET}` },
  })
  if (!resp.ok) throw new Error(`stripe GET ${path} -> ${resp.status}`)
  return resp.json()
}

async function findCustomerRowByStripeId(stripeCustomerId) {
  const rows = await supa(`billing_customers?stripe_customer_id=eq.${encodeURIComponent(stripeCustomerId)}&select=*`)
  return rows?.[0] || null
}

async function upsertSubscription(sub) {
  const customerRow = await findCustomerRowByStripeId(sub.customer)
  if (!customerRow) return
  const priceId = sub.items?.data?.[0]?.price?.id
  const tier = tierForPriceId(priceId) || sub.metadata?.tier || 'solo_starter'
  const cycle = billingCycleForPriceId(priceId)
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
    profile_limit: profileLimitForTier(tier),
  }
  const existing = await supa(`billing_subscriptions?stripe_subscription_id=eq.${encodeURIComponent(sub.id)}&select=id`)
  if (existing && existing.length) {
    await supa(`billing_subscriptions?id=eq.${existing[0].id}`, { method: 'PATCH', body: row })
  } else {
    await supa('billing_subscriptions', { method: 'POST', body: row })
  }
}

async function onSubscriptionDeleted(sub) {
  await supa(`billing_subscriptions?stripe_subscription_id=eq.${encodeURIComponent(sub.id)}`, {
    method: 'PATCH',
    body: { status: 'canceled', canceled_at: new Date().toISOString() },
    prefer: 'return=minimal',
  })
}

async function routeEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
      // Subscription will follow via subscription.created; nothing critical to do here.
      return
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.trial_will_end':
      return upsertSubscription(event.data.object)
    case 'customer.subscription.deleted':
      return onSubscriptionDeleted(event.data.object)
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed': {
      const subId = event.data.object.subscription
      if (subId) {
        const sub = await stripeGet(`/subscriptions/${subId}`)
        return upsertSubscription(sub)
      }
      return
    }
    default:
      return
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } })
  }
  if (!WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: 'STRIPE_WEBHOOK_SECRET not set' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  const rawBody = await req.text()
  const sig = req.headers.get('stripe-signature')
  const verified = await verifySignature(rawBody, sig, WEBHOOK_SECRET)
  if (!verified) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  let event
  try { event = JSON.parse(rawBody) } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  // Idempotency
  try {
    await supa('stripe_events', {
      method: 'POST',
      body: { stripe_event_id: event.id, event_type: event.type, payload: event },
      prefer: 'return=minimal',
    })
  } catch (err) {
    if (err.status === 409 || err.data?.code === '23505') {
      return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: 'idempotency insert failed', detail: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  let handlerError = null
  try {
    await routeEvent(event)
  } catch (err) {
    handlerError = err.message || String(err)
  }

  try {
    await supa(`stripe_events?stripe_event_id=eq.${encodeURIComponent(event.id)}`, {
      method: 'PATCH',
      body: { processed_at: new Date().toISOString(), error: handlerError },
      prefer: 'return=minimal',
    })
  } catch {}

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
