// Stripe webhook handler — Edge Runtime so we get raw body cleanly via req.text().
// Node Functions on Vercel auto-parse req.body, breaking signature verification.

import { TIERS, tierForPriceId, billingCycleForPriceId, profileLimitForTier } from './_lib/billing.js'
import { sendEmailSafe } from './_lib/email.js'
import {
  purchaseEmail,
  upgradeEmail,
  downgradeEmail,
  cancelEmail,
  paymentFailedEmail,
} from './_lib/email-templates.js'

export const config = { runtime: 'edge' }

// Tier ordering for upgrade/downgrade detection. Higher = more access.
// `founding` sits at solo_pro level since it grants pro-equivalent
// limits at a discount; treat lateral moves as not-an-upgrade.
const TIER_RANK = {
  solo_starter: 1,
  founding:     2,
  solo_pro:     2,
  solo_studio:  3,
}
const tierRank = (t) => TIER_RANK[t] || 0
const tierLabel = (t) => TIERS[t]?.name || t || 'plan'

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY

// Tolerance for timestamp freshness (replay protection). 5 minutes matches Stripe's recommendation.
const SIGNATURE_TOLERANCE_SECONDS = 300

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

  // Replay protection: reject signatures older than the tolerance window.
  const ts = parseInt(t, 10)
  if (!Number.isFinite(ts)) return false
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - ts) > SIGNATURE_TOLERANCE_SECONDS) {
    console.warn(`[stripe-webhook] signature timestamp ${ts} outside tolerance (now=${nowSec})`)
    return false
  }

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

// Resolve the email we should notify. Prefer the canonical email on
// auth.users; fall back to billing_customers.email (the value Stripe
// gave us at checkout) which is normally the same anyway.
async function emailForCustomer(customerRow) {
  if (!customerRow) return null
  if (customerRow.user_id) {
    try {
      const auth = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${customerRow.user_id}`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      })
      if (auth.ok) {
        const u = await auth.json()
        if (u?.email) return u.email
      }
    } catch {}
  }
  return customerRow.email || null
}

// Look up the prior subscription row for this Stripe subscription so we
// can diff tier / cancel-state and choose the right email.
async function priorSub(stripeSubId) {
  const rows = await supa(
    `billing_subscriptions?stripe_subscription_id=eq.${encodeURIComponent(stripeSubId)}&select=tier,billing_cycle,status,cancel_at_period_end&limit=1`
  )
  return rows?.[0] || null
}

async function upsertSubscription(sub, eventType) {
  const customerRow = await findCustomerRowByStripeId(sub.customer)
  if (!customerRow) return
  const priceId = sub.items?.data?.[0]?.price?.id
  const tier = tierForPriceId(priceId) || sub.metadata?.tier || 'solo_starter'
  const cycle = billingCycleForPriceId(priceId)
  // Snapshot the prior state BEFORE writing so we can diff and pick
  // the right transactional email below.
  const before = await priorSub(sub.id)
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null

  const row = {
    customer_id: customerRow.id,
    stripe_subscription_id: sub.id,
    stripe_price_id: priceId,
    tier,
    billing_cycle: cycle,
    status: sub.status,
    trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    current_period_start: sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : null,
    current_period_end:   periodEnd,
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

  // Pick the right email to send. Order matters — only one email per
  // event. Skip silently if status is incomplete/past_due transient.
  await sendLifecycleEmail({
    eventType,
    customerRow,
    before,
    after: { tier, billing_cycle: cycle, status: sub.status, cancel_at_period_end: !!sub.cancel_at_period_end, period_end: periodEnd },
    priceAmount: sub.items?.data?.[0]?.price?.unit_amount,
  })

  // M2: keep monthly_grant amounts in sync with the current tier (for the cron).
  const credits = TIERS[tier]?.credits || { ai_tokens: 0, video_units: 0, voice_minutes: 0 }
  await supa('rpc/set_pool_grants', {
    method: 'POST',
    body: {
      p_customer_id: customerRow.id,
      p_ai_tokens:   credits.ai_tokens,
      p_video_units: credits.video_units,
      p_voice_min:   credits.voice_minutes,
    },
  }).catch((e) => console.warn('set_pool_grants failed:', e.message))

  // Initial credit grant — idempotent on stripe_subscription_id.
  await Promise.all(['ai_tokens','video_units','voice_minutes'].map((p) =>
    supa('rpc/grant_credits', {
      method: 'POST',
      body: {
        p_customer_id: customerRow.id,
        p_pool_type: p,
        p_amount: credits[p] || 0,
        p_action: 'subscription_initial',
        p_ref_id: sub.id,
        p_metadata: { tier },
      },
    }).catch((e) => console.warn(`initial grant ${p} failed:`, e.message))
  ))
}

// M2: top-up Checkout completed → grant credits to the matching pool.
async function onTopupCompleted(session) {
  const meta = session.metadata || {}
  if (meta.kind !== 'credit_topup') return

  const customerRow = await findCustomerRowByStripeId(session.customer)
  if (!customerRow) return

  const pool = meta.pool
  const amount = Number(meta.amount)
  if (!pool || !amount) return

  await supa('rpc/grant_credits', {
    method: 'POST',
    body: {
      p_customer_id: customerRow.id,
      p_pool_type: pool,
      p_amount: amount,
      p_action: 'topup',
      p_ref_id: session.id,
      p_metadata: { pack: meta.pack, stripe_session_id: session.id },
    },
  })
}

async function onSubscriptionDeleted(sub) {
  await supa(`billing_subscriptions?stripe_subscription_id=eq.${encodeURIComponent(sub.id)}`, {
    method: 'PATCH',
    body: { status: 'canceled', canceled_at: new Date().toISOString() },
    prefer: 'return=minimal',
  })
  // Final cancellation notice. customer.subscription.deleted fires when
  // the subscription is actually terminated (either at period end or
  // immediately if Stripe was told to cancel-now). The "scheduled to
  // cancel" notice already went out on the subscription.updated event
  // when cancel_at_period_end flipped to true.
  try {
    const customerRow = await findCustomerRowByStripeId(sub.customer)
    const to = await emailForCustomer(customerRow)
    if (to) {
      const tier = tierForPriceId(sub.items?.data?.[0]?.price?.id) || sub.metadata?.tier
      const periodEndIso = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
      const immediate = !sub.current_period_end || (sub.canceled_at && (Math.abs(sub.canceled_at - sub.current_period_end) < 60))
      const { subject, html, text } = cancelEmail({ tierName: tierLabel(tier), periodEndIso, immediate })
      await sendEmailSafe({ to, subject, html, text })
    }
  } catch {}
}

// Decide which lifecycle email (if any) to send based on the diff
// between the prior subscription row and the new state. Returns
// nothing — fire-and-forget. Errors are swallowed by sendEmailSafe.
async function sendLifecycleEmail({ eventType, customerRow, before, after, priceAmount }) {
  // Don't email on transient incomplete states.
  if (after.status === 'incomplete' || after.status === 'incomplete_expired') return

  const to = await emailForCustomer(customerRow)
  if (!to) return

  // First-time activation: no prior row OR prior status was
  // 'incomplete'/null and now we're active or trialing. Either way the
  // user just bought.
  const wasFirstActive = !before || (before.status !== 'active' && before.status !== 'trialing')
  if (wasFirstActive && (after.status === 'active' || after.status === 'trialing')) {
    const { subject, html, text } = purchaseEmail({
      tierName: tierLabel(after.tier),
      amountCents: priceAmount,
      billingCycle: after.billing_cycle,
      email: to,
    })
    await sendEmailSafe({ to, subject, html, text })
    return
  }

  // Cancel-at-period-end just toggled true → scheduled cancellation.
  if (before && !before.cancel_at_period_end && after.cancel_at_period_end) {
    const { subject, html, text } = cancelEmail({
      tierName: tierLabel(after.tier),
      periodEndIso: after.period_end,
      immediate: false,
    })
    await sendEmailSafe({ to, subject, html, text })
    return
  }

  // Tier moved up / down (price change). Don't fire on lateral changes
  // (e.g. solo_pro monthly → solo_pro annual is a billing-cycle swap,
  // not an upgrade).
  if (before && before.tier !== after.tier) {
    const oldRank = tierRank(before.tier)
    const newRank = tierRank(after.tier)
    if (newRank > oldRank) {
      const { subject, html, text } = upgradeEmail({
        tierName: tierLabel(after.tier),
        previousTierName: tierLabel(before.tier),
        amountCents: priceAmount,
        billingCycle: after.billing_cycle,
      })
      await sendEmailSafe({ to, subject, html, text })
    } else if (newRank < oldRank) {
      const { subject, html, text } = downgradeEmail({
        tierName: tierLabel(after.tier),
        previousTierName: tierLabel(before.tier),
        periodEndIso: after.period_end,
      })
      await sendEmailSafe({ to, subject, html, text })
    }
    return
  }
  // Otherwise: no email (billing-cycle swap, status sync, period
  // rollover via invoice.payment_succeeded, etc. all silent).
}

// Payment failure path — separate from the upsert flow because the
// invoice.payment_failed event carries the failure detail. The
// subscription row gets updated by the existing routeEvent path; this
// handler only sends the user-facing notice.
async function onPaymentFailed(invoice) {
  try {
    const customerRow = await findCustomerRowByStripeId(invoice.customer)
    const to = await emailForCustomer(customerRow)
    if (!to) return
    const tier = (await priorSub(invoice.subscription))?.tier
    const { subject, html, text } = paymentFailedEmail({
      tierName: tierLabel(tier),
      amountCents: invoice.amount_due,
    })
    await sendEmailSafe({ to, subject, html, text })
  } catch {}
}

async function routeEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
      // Top-up purchases are one-shot (mode=payment) — grant credits here.
      // Subscription Checkouts trigger customer.subscription.created separately.
      return onTopupCompleted(event.data.object)
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.trial_will_end':
      return upsertSubscription(event.data.object, event.type)
    case 'customer.subscription.deleted':
      return onSubscriptionDeleted(event.data.object)
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed': {
      const invoice = event.data.object
      const subId = invoice.subscription
      if (subId) {
        const sub = await stripeGet(`/subscriptions/${subId}`)
        await upsertSubscription(sub, event.type)
      }
      // Also send a payment-failure notice on a failed invoice — gives
      // the user a chance to update their card before Stripe's retries
      // run out and the subscription cancels.
      if (event.type === 'invoice.payment_failed') {
        await onPaymentFailed(invoice)
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
