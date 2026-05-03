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
