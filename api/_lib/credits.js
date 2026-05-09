// Server-side credit lib. Wraps the Postgres helpers with REST calls.
// Used by stripe-webhook (grants), AI endpoints (consume), and cron (monthly reset).

import { supaFetch } from './supabase.js'
import { TIERS } from './billing.js'

// Convenience: tier → 3-pool grant amounts.
export function grantsForTier(tier) {
  const def = TIERS[tier]
  if (!def) return { ai_tokens: 0, video_units: 0, voice_minutes: 0 }
  return {
    ai_tokens:     def.credits?.ai_tokens     ?? 0,
    video_units:   def.credits?.video_units   ?? 0,
    voice_minutes: def.credits?.voice_minutes ?? 0,
  }
}

// Look up the customer_id (billing) for an authenticated user_id.
export async function customerIdForUser(userId) {
  const rows = await supaFetch(
    `billing_customers?user_id=eq.${userId}&select=id`
  )
  return rows?.[0]?.id || null
}

// Set monthly_grant amounts on all 3 pools (call on sub create/update).
export async function setPoolGrants(customerId, tier) {
  const g = grantsForTier(tier)
  await supaFetch('rpc/set_pool_grants', {
    method: 'POST',
    body: {
      p_customer_id: customerId,
      p_ai_tokens:   g.ai_tokens,
      p_video_units: g.video_units,
      p_voice_min:   g.voice_minutes,
    },
  })
}

// Idempotent grant. Returns new balance, or null if already applied.
export async function grant({ customerId, poolType, amount, action, refId, metadata }) {
  const result = await supaFetch('rpc/grant_credits', {
    method: 'POST',
    body: {
      p_customer_id: customerId,
      p_pool_type:   poolType,
      p_amount:      amount,
      p_action:      action,
      p_ref_id:      refId || null,
      p_metadata:    metadata || {},
    },
  })
  // RPC returns the scalar directly
  return Array.isArray(result) ? result[0] : result
}

// Atomic consume: returns { success, balance_after, error_code }.
// error_code values: 'invalid_amount' | 'pool_missing' | 'insufficient' | null
export async function consume({ customerId, poolType, amount, action, refTable, refId, profileId, metadata }) {
  const rows = await supaFetch('rpc/consume_credits', {
    method: 'POST',
    body: {
      p_customer_id: customerId,
      p_pool_type:   poolType,
      p_amount:      amount,
      p_action:      action,
      p_ref_table:   refTable || null,
      p_ref_id:      refId || null,
      p_profile_id:  profileId || null,
      p_metadata:    metadata || {},
    },
  })
  return Array.isArray(rows) ? rows[0] : rows
}

// Initial grant on a brand-new subscription. Idempotent on stripe_subscription_id.
export async function grantInitialForSubscription(customerId, tier, stripeSubId) {
  const g = grantsForTier(tier)
  await Promise.all([
    grant({ customerId, poolType: 'ai_tokens',     amount: g.ai_tokens,     action: 'subscription_initial', refId: stripeSubId, metadata: { tier } }),
    grant({ customerId, poolType: 'video_units',   amount: g.video_units,   action: 'subscription_initial', refId: stripeSubId, metadata: { tier } }),
    grant({ customerId, poolType: 'voice_minutes', amount: g.voice_minutes, action: 'subscription_initial', refId: stripeSubId, metadata: { tier } }),
  ])
}

// ── withCreditReservation ─────────────────────────────────────────────────
// Reserve credits BEFORE doing expensive upstream work, refund the
// reservation if the work throws. This eliminates the "two concurrent
// requests both pre-pass, only one consume succeeds, second user gets
// the work for free" race that was the dominant revenue-leak pattern
// across the codebase.
//
// Usage:
//   try {
//     return await withCreditReservation({
//       userId: auth.user.id,
//       poolType: 'ai_tokens',
//       amount: 4000,
//       action: 'consume:image-gen',
//       profileId: profile_id,
//       metadata: { model, count },
//     }, async () => {
//       const result = await callKie(...)
//       return res.status(200).json(result)
//     })
//   } catch (e) {
//     // already-refunded; surface the error as you normally would.
//     return res.status(500).json({ error: e.message })
//   }
//
// On insufficient credits, throws { code:'insufficient_credits', need }
// before invoking the work. The caller catches and returns 402.
//
// On work success, no further action — the reservation is already a
// real consume.
//
// On work failure (any throw from the inner fn), issues an idempotent
// refund grant tagged with action='refund:<original>' and ref_id=
// the original action+timestamp so a subsequent retry gets a fresh
// reservation but never double-refunds.
//
// Skipped entirely (work runs uncharged) when the user has no
// billing_customer row — typical of admins / support accounts. Logs
// loudly so this doesn't become a backdoor.
export async function withCreditReservation({
  userId, poolType, amount, action, profileId = null, metadata = {},
  // Optional: provide your own ref_id (e.g. an upstream task id like a
  // KIE taskId or HeyGen render id) so a separate endpoint can later
  // refund using the same id and grant_credits' idempotency kicks in.
  // When omitted, an internal random id is generated.
  refId: providedRefId = null,
}, fn) {
  if (!userId || !action) throw new Error('userId + action required')
  if (!Number.isFinite(amount) || amount <= 0) {
    // Free action — just run.
    return await fn({ customerId: null, refundIfFailed: async () => {} })
  }

  const customerId = await customerIdForUser(userId)
  if (!customerId) {
    console.warn('withCreditReservation: no billing_customer for user, running uncharged', { userId, action, amount })
    return await fn({ customerId: null, refundIfFailed: async () => {} })
  }

  // Reserve atomically. consume_credits is FOR UPDATE inside the
  // function, so two concurrent reservations serialize and only the
  // one with sufficient balance wins.
  const refId = providedRefId || `${action}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  const result = await consume({
    customerId, poolType, amount, action, profileId,
    metadata: { ...metadata, reservation: true, ref: refId },
  })
  if (!result?.success) {
    const err = new Error(result?.error_code === 'insufficient' ? 'Insufficient credits.' : `Credit reservation failed: ${result?.error_code || 'unknown'}`)
    err.code = result?.error_code === 'insufficient' ? 'insufficient_credits' : 'credit_error'
    err.status = 402
    err.need = amount
    throw err
  }

  let workSucceeded = false
  try {
    const out = await fn({
      customerId,
      refId,
      // Tag the consume row's metadata with extra fields the caller
      // discovers AFTER reserving (e.g. KIE taskId, HeyGen render_id).
      // Used so a separate status endpoint can refund-by-metadata.
      // Best-effort; never throws.
      tagMetadata: async (extra) => {
        if (!extra || typeof extra !== 'object') return
        try {
          // PostgREST: PATCH credit_transactions where ref_id = refId
          // AND action = the consume action. metadata is jsonb, use
          // `||` to merge atomically inside Postgres.
          const merged = { ...(metadata || {}), ...extra, reservation: true, ref: refId }
          await supaFetch(
            `credit_transactions?action=eq.${encodeURIComponent(action)}&ref_id=eq.${encodeURIComponent(refId)}`,
            { method: 'PATCH', body: { metadata: merged }, prefer: 'return=minimal' }
          )
        } catch (e) {
          console.warn('tagMetadata failed:', e?.message)
        }
      },
      refundIfFailed: async (refundAmount = amount) => {
        if (!Number.isFinite(refundAmount) || refundAmount <= 0) return
        await grant({
          customerId, poolType, amount: refundAmount,
          action: `refund:${action}`,
          refId,
          metadata: { ...metadata, refunded: refundAmount, original_amount: amount },
        }).catch((e) => console.error('withCreditReservation: explicit refund failed', e?.message))
      },
    })
    workSucceeded = true
    return out
  } finally {
    if (!workSucceeded) {
      // Auto-refund on uncaught throw. Idempotent because grant_credits
      // upserts on (customer_id, action, ref_id) — a retry never
      // double-refunds.
      try {
        await grant({
          customerId, poolType, amount,
          action: `refund:${action}`,
          refId,
          metadata: { ...metadata, auto_refund: true, original_amount: amount },
        })
      } catch (e) {
        console.error('withCreditReservation: auto-refund failed', { userId, action, amount, refId, message: e?.message })
        // Capture in Sentry — this is the worst-case "user paid for
        // nothing AND we couldn't even refund them" state.
        try {
          const { captureApiError } = await import('./sentry.js')
          captureApiError(e, {
            route: 'withCreditReservation:auto_refund',
            userId, profileId,
            extra: { customerId, action, amount, refId, kind: 'unrefunded_charge' },
          })
        } catch {}
      }
    }
  }
}

// Refund a previously consumed credit by looking up the consume row
// via a metadata key (e.g. taskId for image-gen, render_id for avatar
// renders). Idempotent on (customer, action='refund:<orig>', ref_id=
// the consume row's ref_id) so a status endpoint that polls the same
// failed task multiple times only refunds once.
//
// Returns:
//   { refunded: true,  amount, ref_id }   — refund issued
//   { refunded: false, reason: 'not_found' | 'already_refunded' | '...' }
export async function refundConsumeByMetadata({ originalAction, metadataKey, metadataValue, profileId = null }) {
  if (!originalAction || !metadataKey || !metadataValue) {
    return { refunded: false, reason: 'missing_args' }
  }
  // Find the consume row. Filter by action + metadata key. PostgREST's
  // jsonb operator: `metadata->>key=eq.<value>`.
  const filter = `action=eq.${encodeURIComponent(originalAction)}&metadata->>${encodeURIComponent(metadataKey)}=eq.${encodeURIComponent(metadataValue)}&delta=lt.0&order=created_at.desc&limit=1`
  const rows = await supaFetch(`credit_transactions?${filter}&select=*`).catch(() => [])
  const row = rows?.[0]
  if (!row) return { refunded: false, reason: 'not_found' }

  const refundAmount = Math.abs(Number(row.delta) || 0)
  if (refundAmount <= 0) return { refunded: false, reason: 'zero_amount' }

  await grant({
    customerId: row.customer_id,
    poolType:   row.pool_type,
    amount:     refundAmount,
    action:     `refund:${originalAction}`,
    refId:      row.ref_id || row.id,
    metadata: {
      auto_refund_via: 'refundConsumeByMetadata',
      original_action: originalAction,
      [metadataKey]: metadataValue,
      original_tx_id: row.id,
      profile_id: profileId,
    },
  })
  return { refunded: true, amount: refundAmount, ref_id: row.ref_id || row.id }
}

// Top-up pack catalog (env-driven Stripe prices).
export const TOPUP_PACKS = {
  ai_tokens_100k:  { pool: 'ai_tokens',     amount:   100_000, usd:  10, label: '100K AI tokens',     priceId: process.env.STRIPE_PRICE_TOPUP_AI_100K },
  ai_tokens_500k:  { pool: 'ai_tokens',     amount:   500_000, usd:  40, label: '500K AI tokens',     priceId: process.env.STRIPE_PRICE_TOPUP_AI_500K },
  ai_tokens_2m:    { pool: 'ai_tokens',     amount: 2_000_000, usd: 120, label: '2M AI tokens',       priceId: process.env.STRIPE_PRICE_TOPUP_AI_2M },
  video_units_10:  { pool: 'video_units',   amount:        10, usd:  20, label: '10 video units',     priceId: process.env.STRIPE_PRICE_TOPUP_VIDEO_10 },
  video_units_50:  { pool: 'video_units',   amount:        50, usd:  80, label: '50 video units',     priceId: process.env.STRIPE_PRICE_TOPUP_VIDEO_50 },
}

// Catalog as a public-safe JSON (strips priceId, keeps a 'available' flag).
export function publicTopupCatalog() {
  return Object.fromEntries(
    Object.entries(TOPUP_PACKS).map(([k, v]) => [k, {
      pool: v.pool,
      amount: v.amount,
      usd: v.usd,
      label: v.label,
      available: !!v.priceId,
    }])
  )
}
