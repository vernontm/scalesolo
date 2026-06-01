// Stripe webhook handler — Edge Runtime so we get raw body cleanly via req.text().
// Node Functions on Vercel auto-parse req.body, breaking signature verification.

import { TIERS, tierForPriceId, billingCycleForPriceId, profileLimitForTier } from './_lib/billing.js'
import { sendEmailSafe, brandedEmail, ctaButton } from './_lib/email.js'
import {
  purchaseEmail,
  upgradeEmail,
  downgradeEmail,
  cancelEmail,
  paymentFailedEmail,
} from './_lib/email-templates.js'
import { sendCAPIPurchase } from './_lib/meta-capi.js'

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

// Used by the public-signup flow: when a webhook fires for a Stripe
// customer we've never seen (anonymous checkout, signup hasn't
// happened yet), create the billing_customers row with user_id=null
// + email pulled from Stripe so we don't lose the subscription. The
// signup page calls /api/stripe-link-session post-account-creation
// to fill in user_id.
async function ensureCustomerRowForStripe(stripeCustomerId, fallbackEmail) {
  if (!stripeCustomerId) return null
  const existing = await findCustomerRowByStripeId(stripeCustomerId)
  if (existing) return existing
  let email = fallbackEmail || null
  if (!email) {
    try {
      const cust = await stripeGet(`/customers/${encodeURIComponent(stripeCustomerId)}`)
      email = cust?.email || null
    } catch { /* swallow — email is best-effort here */ }
  }
  const created = await supa('billing_customers', {
    method: 'POST',
    body: {
      user_id: null,
      email,
      stripe_customer_id: stripeCustomerId,
    },
  })
  return Array.isArray(created) ? created[0] : created
}

// ── Affiliate commissions ──────────────────────────────────────────────────
// Tier rates kept in sync with api/_lib/affiliate.js — duplicated here
// because the webhook runs in Edge runtime and the shared helper isn't
// edge-safe (it imports the node supabase helper).
const AFFILIATE_RATE_BY_TIER = { starter: 0.20, pro: 0.35, elite: 0.50 }

async function recordAffiliateCommission(invoice) {
  if (!invoice?.id) return
  const amountPaid = Number(invoice.amount_paid) || 0
  if (amountPaid <= 0) return
  // Subscription invoices only — one-off topups don't earn affiliate
  // commission (same convention most affiliate programs use).
  if (!invoice.subscription) return

  // Idempotency: never log the same invoice twice.
  const dup = await supa(
    `affiliate_commissions?stripe_invoice_id=eq.${encodeURIComponent(invoice.id)}&select=id`
  ).catch(() => [])
  if (dup?.length) return

  // Resolve referred user_id via billing_customers → user_id, then
  // affiliate_referrals.
  const customerRow = await findCustomerRowByStripeId(invoice.customer)
  const userId = customerRow?.user_id
  if (!userId) return

  const refs = await supa(
    `affiliate_referrals?referred_user_id=eq.${userId}&select=id,affiliate_id,first_paid_at`
  ).catch(() => [])
  const ref = refs?.[0]
  if (!ref) return

  const affRows = await supa(
    `affiliates?id=eq.${ref.affiliate_id}&select=tier,status`
  ).catch(() => [])
  const aff = affRows?.[0]
  if (!aff || aff.status !== 'approved') return  // Only approved affiliates earn

  const rate = AFFILIATE_RATE_BY_TIER[aff.tier] ?? AFFILIATE_RATE_BY_TIER.starter
  const commissionCents = Math.round(amountPaid * rate)
  if (commissionCents <= 0) return

  await supa('affiliate_commissions', {
    method: 'POST',
    body: [{
      affiliate_id: ref.affiliate_id,
      referral_id: ref.id,
      stripe_invoice_id: invoice.id,
      stripe_customer_id: invoice.customer,
      gross_amount_cents: amountPaid,
      commission_rate: rate,
      commission_cents: commissionCents,
      currency: (invoice.currency || 'usd').toLowerCase(),
      status: 'pending',
      invoice_paid_at: new Date((invoice.status_transitions?.paid_at || invoice.created || Date.now() / 1000) * 1000).toISOString(),
    }],
    prefer: 'return=minimal',
  })

  // Stamp first_paid_at on the referral so admin tier-promotion logic
  // can count paying referrals without re-querying invoices.
  if (!ref.first_paid_at) {
    await supa(`affiliate_referrals?id=eq.${ref.id}`, {
      method: 'PATCH',
      body: { first_paid_at: new Date().toISOString() },
      prefer: 'return=minimal',
    }).catch(() => {})
  }
}

// Refund clawback. Looks up any commission tied to the invoice the
// refunded charge paid, and flips it to status='clawed_back' so we
// don't pay out on it. Does nothing if the commission was already paid
// (we don't reverse paid payouts here — that's a manual call).
async function clawbackAffiliateCommission(charge) {
  if (!charge) return
  const invoiceId = charge.invoice
  if (!invoiceId) return
  // Only meaningful when something was actually refunded.
  const refundedCents = Number(charge.amount_refunded) || 0
  if (refundedCents <= 0) return

  const rows = await supa(
    `affiliate_commissions?stripe_invoice_id=eq.${encodeURIComponent(invoiceId)}&select=id,status`
  ).catch(() => [])
  const c = rows?.[0]
  if (!c) return
  // Already paid out → leave alone (admin handles reversals manually).
  if (c.status === 'paid') return
  if (c.status === 'clawed_back') return

  await supa(`affiliate_commissions?id=eq.${c.id}`, {
    method: 'PATCH',
    body: { status: 'clawed_back' },
    prefer: 'return=minimal',
  }).catch(() => {})
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
  // Public-signup flow: this may be the FIRST webhook for a Stripe
  // customer we've never seen (visitor checked out before they had
  // a Supabase account). Auto-create the billing_customers row so we
  // don't drop the subscription on the floor; signup links user_id
  // afterwards via /api/stripe-link-session.
  const customerRow = await ensureCustomerRowForStripe(sub.customer)
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

  // M2: keep monthly_grant amounts in sync with the user's CURRENT
  // entitlement. We only bump monthly_grant to tier-level when the sub
  // is genuinely active (paid). For trialing / past_due / unpaid /
  // incomplete we hold at trial-baseline so the monthly-reset cron
  // doesn't refill paid-tier amounts on a non-paid subscription.
  //
  // Roemon-bug history: this used to set tier-level grants
  // unconditionally on customer.subscription.updated, so when Stripe
  // flipped trialing→active before the renewal invoice settled, a
  // failed charge still left the user with monthly_grant=1M.
  const tierCredits = TIERS[tier]?.credits || { ai_tokens: 0, video_units: 0, voice_minutes: 0 }
  const trialGrant  = { ai_tokens: 5_000, video_units: 5, voice_minutes: 0 }
  const isTrial = sub.status === 'trialing'
  const isPaidActive = sub.status === 'active'
  const grantsForCron = isPaidActive ? tierCredits : trialGrant
  await supa('rpc/set_pool_grants', {
    method: 'POST',
    body: {
      p_customer_id: customerRow.id,
      p_ai_tokens:   grantsForCron.ai_tokens,
      p_video_units: grantsForCron.video_units,
      p_voice_min:   grantsForCron.voice_minutes,
    },
  }).catch((e) => console.warn('set_pool_grants failed:', e.message))

  // Initial credit grant. The trial grant is small (5k tokens +
  // 5 video_units = one 30-sec avatar) so a sign-up-and-cancel can't
  // drain the full tier. Idempotent on stripe_subscription_id.
  // NOTE: we no longer grant the conversion topup here. That moved to
  // invoice.payment_succeeded so the topup only fires once Stripe
  // actually collects the first paid invoice.
  const grantForInitial = isTrial ? trialGrant : tierCredits
  await Promise.all(['ai_tokens','video_units','voice_minutes'].map((p) =>
    supa('rpc/grant_credits', {
      method: 'POST',
      body: {
        p_customer_id: customerRow.id,
        p_pool_type: p,
        p_amount: grantForInitial[p] || 0,
        p_action: 'subscription_initial',
        p_ref_id: sub.id,
        p_metadata: { tier, trial: isTrial },
      },
    }).catch((e) => console.warn(`initial grant ${p} failed:`, e.message))
  ))

  // SCALE bonus — funnel reader reward. When the marketing-funnel
  // checkout passes bonus_code='scale' on a Founding signup, we grant
  // +50% on top of the normal Founding monthly credits ONCE on
  // creation. Idempotent via ref_id suffix. (The price stays at $79;
  // SCALE adds value, not a discount — the value-stack model.)
  const subMeta = sub.metadata || {}
  const isScaleBonus = (subMeta.bonus_code === 'scale') && tier === 'founding'
  const isInitialCreation = eventType === 'customer.subscription.created' && !before
  if (isScaleBonus && isInitialCreation) {
    const bonusAi = Math.floor((tierCredits.ai_tokens || 0) * 0.5)
    const bonusVid = Math.floor((tierCredits.video_units || 0) * 0.5)
    await Promise.all([
      bonusAi && supa('rpc/grant_credits', {
        method: 'POST',
        body: {
          p_customer_id: customerRow.id,
          p_pool_type: 'ai_tokens',
          p_amount: bonusAi,
          p_action: 'scale_bonus_initial',
          p_ref_id: `${sub.id}:scale-bonus`,
          p_metadata: { code: 'SCALE', tier },
        },
      }).catch((e) => console.warn('scale bonus ai_tokens failed:', e.message)),
      bonusVid && supa('rpc/grant_credits', {
        method: 'POST',
        body: {
          p_customer_id: customerRow.id,
          p_pool_type: 'video_units',
          p_amount: bonusVid,
          p_action: 'scale_bonus_initial',
          p_ref_id: `${sub.id}:scale-bonus`,
          p_metadata: { code: 'SCALE', tier },
        },
      }).catch((e) => console.warn('scale bonus video_units failed:', e.message)),
    ])

    // Tag the funnel contact (if we have one) so the team books the
    // 1-on-1 setup call promised in the SCALE stack. Best-effort.
    const funnelProfileId = process.env.FUNNEL_PROFILE_ID
    const subEmail = (customerRow.email || sub.customer_email || '').toLowerCase()
    if (funnelProfileId && subEmail) {
      try {
        const found = await supa(
          `email_contacts?profile_id=eq.${funnelProfileId}&email=eq.${encodeURIComponent(subEmail)}&select=id,tags`
        )
        if (found && found.length) {
          const tagSet = new Set(found[0].tags || [])
          tagSet.add('founding:scale')
          tagSet.add('setup-call:pending')
          await supa(`email_contacts?id=eq.${found[0].id}`, {
            method: 'PATCH',
            body: { tags: Array.from(tagSet) },
          })
        }
      } catch (e) { console.warn('scale contact tag failed:', e.message) }
    }
  }
}

// Trial→paid conversion topup. Top up the difference between what we
// already granted (trial allowance) and what the tier actually
// includes. Called from invoice.payment_succeeded so the topup only
// fires once Stripe has actually charged the card.
//
// Idempotent: ref_id `${sub.id}:conversion` is unique-per-sub. Re-firing
// on subsequent monthly renewals no-ops because the topup math goes to
// zero after the first successful application (and the underlying RPC
// dedupes on ref_id anyway).
async function grantConversionTopup(customerRow, sub) {
  const priceId = sub.items?.data?.[0]?.price?.id || sub.items?.data?.[0]?.plan?.id
  const tier = tierForPriceId(priceId) || sub.metadata?.tier || 'solo_starter'
  const tierCredits = TIERS[tier]?.credits || { ai_tokens: 0, video_units: 0, voice_minutes: 0 }
  const trialGrant  = { ai_tokens: 5_000, video_units: 5, voice_minutes: 0 }
  await Promise.all(['ai_tokens','video_units','voice_minutes'].map((p) => {
    const topup = Math.max(0, (tierCredits[p] || 0) - (trialGrant[p] || 0))
    if (!topup) return null
    return supa('rpc/grant_credits', {
      method: 'POST',
      body: {
        p_customer_id: customerRow.id,
        p_pool_type: p,
        p_amount: topup,
        p_action: 'subscription_trial_conversion',
        p_ref_id: `${sub.id}:conversion`,
        p_metadata: { tier },
      },
    }).catch((e) => console.warn(`conversion grant ${p} failed:`, e.message))
  }))
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

// Mirror the browser-side fbq Purchase event server-side via Meta's
// Conversions API. eventId = the Stripe checkout-session id so Meta
// dedupes this server-side event with the browser-side one fired
// from src/lib/meta-pixel.js trackPurchase() on /login?stripe_session=…
// after the redirect back from Stripe. Anything Meta can pull from
// the session (email, name, address) gets hashed + included so the
// event matches a Facebook user with a high match rate.
//
// Fire-and-await-with-cap pattern: we await the CAPI call so the
// fetch actually completes (Edge Runtime freezes after response),
// but we never throw — a CAPI failure logs and moves on. The
// Stripe webhook must respond to Stripe within ~10s regardless.
async function fireCAPIPurchaseFromSession(session) {
  try {
    if (!session?.id) return
    // Skip non-paying sessions defensively. If payment_status is
    // anything other than 'paid' / 'no_payment_required' we don't
    // want to count it as a Purchase.
    const ps = String(session.payment_status || '').toLowerCase()
    if (ps && ps !== 'paid' && ps !== 'no_payment_required') return

    const cd = session.customer_details || {}
    const addr = cd.address || {}
    // Stripe gives the full name in one field — split on whitespace
    // for first / last. Matches what Meta expects (separate fn / ln).
    const fullName = (cd.name || '').trim()
    const nameParts = fullName ? fullName.split(/\s+/) : []
    const firstName = nameParts[0] || null
    const lastName  = nameParts.length > 1 ? nameParts.slice(-1)[0] : null

    // The $1 trial activation fee is a fixed 100 cents — but if the
    // session amount_total is non-zero we send that instead so we get
    // accurate ROAS reporting on whatever the user actually paid.
    const totalCents = Number(session.amount_total ?? 100)
    const value = Math.max(0.01, totalCents / 100)
    const currency = (session.currency || 'usd').toUpperCase()

    // Reconstruct the source URL so attribution reports show which
    // landing page drove this purchase. Falls back to the bare domain
    // if metadata.source isn't set.
    const baseUrl = process.env.SCALESOLO_DOMAIN || process.env.FRONTEND_URL || 'https://scalesolo.ai'
    const source  = session.metadata?.source || 'unknown'
    const eventSourceUrl = source === 'faceless_brand_landing'
      ? `${baseUrl}/faceless-brand`
      : `${baseUrl}/pricing`

    await sendCAPIPurchase({
      eventId: session.id,
      value,
      currency,
      contentName: session.metadata?.source === 'faceless_brand_landing'
        ? 'Faceless Brand Trial'
        : 'ScaleSolo Subscription',
      eventSourceUrl,
      user: {
        email:      cd.email || session.customer_email || null,
        firstName,
        lastName,
        city:       addr.city || null,
        state:      addr.state || null,
        zip:        addr.postal_code || null,
        country:    addr.country || null,
        externalId: session.client_reference_id || session.customer || null,
        // IP / user-agent / fbc / fbp aren't captured server-side at
        // webhook time (the user finished checkout on Stripe's domain,
        // not ours, so we don't have their browser context). Browser-
        // side Pixel covers these — server-side just adds email +
        // name + address as additional matching signal.
      },
    })
  } catch (err) {
    console.warn('[stripe-webhook] CAPI Purchase mirror failed:', err?.message || err)
  }
}

// ── Funnel purchase email delivery ──────────────────────────────────
// Sends downloads / next-step emails after a funnel purchase so the
// customer has a permanent inbox copy independent of the welcome page.
// Best-effort: errors are swallowed inside sendEmailSafe so a Resend
// hiccup never 500s the webhook.
const FUNNEL_BLUEPRINT_DL = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/build-your-ai-empire.pdf'
const FUNNEL_PACK_DL      = 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/landing-media/faceless-content-pack.zip'
const FUNNEL_BOOK_CALL    = 'https://vernontm.com/book-call'

async function sendFunnelPurchaseEmail({ email, product, bump }) {
  if (!email) return
  if (product === 'tripwire') {
    const parts = [
      '<p style="margin:0 0 12px;font-size:18px;font-weight:700;color:#0c0c0d;">Welcome to the inside.</p>',
      '<p style="margin:0 0 6px;">Thanks for grabbing <b>Build Your AI Empire</b>. Your playbook is below. Save this email — the link lives here forever.</p>',
      ctaButton({ label: 'Download the playbook', url: FUNNEL_BLUEPRINT_DL }),
    ]
    if (bump) {
      parts.push(
        '<p style="margin:18px 0 4px;font-weight:700;color:#0c0c0d;">You also grabbed the Faceless Content Pack:</p>',
        ctaButton({ label: 'Download the Content Pack', url: FUNNEL_PACK_DL })
      )
    }
    parts.push(
      '<p style="margin:18px 0 0;">When you are ready, the next move most readers make is locking in the engine that runs the system. Reply to this email if you have any questions.</p>',
      '<p style="margin:10px 0 0;">— Rayvaughn · ScaleSolo</p>'
    )
    return sendEmailSafe({
      to: email,
      subject: bump
        ? 'Your playbook + Content Pack are inside'
        : 'Your playbook is here — Build Your AI Empire',
      html: brandedEmail({
        preheader: bump ? 'Both download links are inside.' : 'Your download link is inside.',
        body: parts.join(''),
      }),
    })
  }

  if (product === 'dfy' || product === 'dfy_oto') {
    const intro = product === 'dfy_oto'
      ? 'You added the Done-For-You Launch. Smart move.'
      : 'Your Done-For-You Launch is booked.'
    return sendEmailSafe({
      to: email,
      subject: 'Your Done-For-You Launch — book your kickoff call',
      html: brandedEmail({
        preheader: 'Grab a time and we will start the build on the call.',
        body: [
          `<p style="margin:0 0 12px;font-size:18px;font-weight:700;color:#0c0c0d;">${intro}</p>`,
          '<p style="margin:0 0 6px;">Payment received. The fastest next step is to grab a time for your kickoff call — that is where we start the build.</p>',
          ctaButton({ label: 'Book my kickoff call', url: FUNNEL_BOOK_CALL }),
          '<p style="margin:18px 0 0;">On the call we map your brand, your avatar, and your voice. Then my team builds it and hands you the keys. Watch your inbox for a short brand questionnaire shortly after.</p>',
          '<p style="margin:12px 0 0;">— Rayvaughn · ScaleSolo</p>',
        ].join(''),
      }),
    })
  }
}

// Pull email + product flags off a Checkout Session and route to the
// right email template. Handles tripwire, DFY direct, and the OTO 3DS
// fallback Checkout. Plain OTO PaymentIntents are handled separately
// in the payment_intent.succeeded case.
async function sendFunnelCheckoutEmail(session) {
  const meta = session.metadata || {}
  const email = session.customer_details?.email || session.customer_email
  if (!email) return
  if (meta.source === 'funnel') {
    const product = meta.funnel_product
    if (product === 'tripwire' || product === 'dfy') {
      await sendFunnelPurchaseEmail({ email, product, bump: meta.bump === '1' })
    }
  } else if (meta.source === 'funnel_oto_fallback') {
    // 3DS-required OTO that fell back to a fresh Checkout — DFY upgrade.
    await sendFunnelPurchaseEmail({ email, product: 'dfy_oto' })
  }
}

// One-click OTO upsells charge via PaymentIntent.create (not Checkout),
// so we listen for payment_intent.succeeded and trigger the DFY booking
// email when the source flag matches.
async function sendFunnelOtoEmail(pi) {
  if (pi?.metadata?.source !== 'funnel_oto') return
  let email = pi.receipt_email
  if (!email && pi.customer) {
    try {
      const cust = await stripeGet(`/customers/${encodeURIComponent(pi.customer)}`)
      email = cust?.email
    } catch { /* swallow — best effort */ }
  }
  if (email) await sendFunnelPurchaseEmail({ email, product: 'dfy_oto' })
}

async function routeEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
      // Fire Meta CAPI Purchase first (independent of topup vs
      // subscription handling). Server-side dedup-pair with the
      // browser-side fbq Purchase on /login?stripe_session=…
      await fireCAPIPurchaseFromSession(event.data.object)
      // Funnel: deliver downloads / next-step email (tripwire/DFY/OTO-fallback).
      // Fire-and-forget — never block topup credit grants on email.
      try { await sendFunnelCheckoutEmail(event.data.object) }
      catch (e) { console.warn('funnel email failed:', e?.message || e) }
      // Top-up purchases are one-shot (mode=payment) — grant credits here.
      // Subscription Checkouts trigger customer.subscription.created separately.
      return onTopupCompleted(event.data.object)
    case 'payment_intent.succeeded':
      // OTO upsell — the off-session $397 charge from /api/funnel-oto.
      // Fire the DFY booking email so the buyer gets the kickoff-call
      // link in their inbox. Fire-and-forget; any other PaymentIntents
      // are ignored here.
      try { await sendFunnelOtoEmail(event.data.object) }
      catch (e) { console.warn('funnel OTO email failed:', e?.message || e) }
      return
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.trial_will_end':
      return upsertSubscription(event.data.object, event.type)
    case 'customer.subscription.deleted':
      return onSubscriptionDeleted(event.data.object)
    case 'charge.refunded':
    case 'charge.refund.updated': {
      // Pull the invoice id (when present) and clawback any commission
      // we previously logged for it. Refund-on-non-invoice payments
      // (one-off topups) are a no-op here since topups don't earn commission.
      try { await clawbackAffiliateCommission(event.data.object) } catch (e) {
        console.warn('affiliate clawback failed:', e?.message || e)
      }
      return
    }
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed': {
      const invoice = event.data.object
      const subId = invoice.subscription
      let sub = null
      if (subId) {
        sub = await stripeGet(`/subscriptions/${subId}`)
        await upsertSubscription(sub, event.type)
      }
      // Trial → paid conversion topup. Gated here (not on
      // customer.subscription.updated) because Stripe flips a
      // subscription's status trialing→active BEFORE the renewal
      // invoice is actually paid. We only want to top up to tier
      // credits once Stripe has confirmed the charge cleared.
      // billing_reason = 'subscription_cycle' is the post-trial first
      // recurring invoice; later renewals also use this reason but
      // grant_credits is idempotent on ref_id so they no-op.
      if (event.type === 'invoice.payment_succeeded' && sub && invoice.billing_reason === 'subscription_cycle') {
        try {
          const customerRow = await findCustomerRowByStripeId(sub.customer)
          if (customerRow) await grantConversionTopup(customerRow, sub)
        } catch (e) {
          console.warn('conversion topup on payment_succeeded failed:', e?.message || e)
        }
      }
      // Affiliate: every paid invoice from a referred user generates a
      // commission row. Logged independently of the upsert so a logging
      // failure doesn't break the rest of the webhook.
      if (event.type === 'invoice.payment_succeeded') {
        try { await recordAffiliateCommission(invoice) } catch (e) {
          console.warn('affiliate commission record failed:', e?.message || e)
        }
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

  // Idempotency. Only short-circuit when a PRIOR attempt completed
  // successfully (processed_at IS NOT NULL). If a prior attempt errored
  // mid-handler, processed_at is null and we re-process — every grant
  // path is idempotent on its own ref_id, so this is safe.
  let alreadyProcessed = false
  try {
    await supa('stripe_events', {
      method: 'POST',
      body: { stripe_event_id: event.id, event_type: event.type, payload: event },
      prefer: 'return=minimal',
    })
  } catch (err) {
    if (err.status === 409 || err.data?.code === '23505') {
      // Row exists. Check if a previous attempt actually finished.
      try {
        const rows = await supa(
          `stripe_events?stripe_event_id=eq.${encodeURIComponent(event.id)}&select=processed_at,error`
        )
        if (rows?.[0]?.processed_at) alreadyProcessed = true
        // else: previous attempt failed mid-flight; fall through to retry.
      } catch {
        // If we can't read the row, default to safe behavior: short-
        // circuit so we don't double-grant on flaky DB.
        alreadyProcessed = true
      }
    } else {
      return new Response(JSON.stringify({ error: 'idempotency insert failed', detail: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }
  }
  if (alreadyProcessed) {
    return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  let handlerError = null
  try {
    await routeEvent(event)
  } catch (err) {
    handlerError = err.message || String(err)
    // This file runs on Edge runtime; @sentry/node won't bundle here,
    // so we rely on Vercel logs + Stripe's own retry mechanism. Every
    // failed event row also stays unprocessed in stripe_events with
    // an `error` column populated — query for those to reconcile.
    console.error('stripe-webhook routeEvent failed:', event.type, event.id, handlerError, err?.stack)
  }

  // Always record the attempt (success or failure). Failure rows have
  // `error` set + `processed_at` STILL NULL, so a future Stripe retry
  // re-enters the handler. (Stripe retries non-2xx for up to 3 days.)
  try {
    const patch = handlerError
      ? { error: handlerError, last_attempt_at: new Date().toISOString() }
      : { processed_at: new Date().toISOString(), error: null }
    await supa(`stripe_events?stripe_event_id=eq.${encodeURIComponent(event.id)}`, {
      method: 'PATCH',
      body: patch,
      prefer: 'return=minimal',
    })
  } catch {}

  // Return 500 on handler error so Stripe retries (exponential backoff,
  // 3 days). Without this, a transient Supabase blip during a
  // subscription.created handler permanently loses a paying customer's
  // initial credit grant.
  if (handlerError) {
    return new Response(JSON.stringify({ error: 'handler error', detail: handlerError }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
