// Tier catalog. Lives in code (not DB) so it's version-controlled.

// Each tier exposes:
//   profile_limit       — max brand profiles the user can own
//   credits.ai_tokens   — Claude/Anthropic token bucket
//   credits.video_units — HeyGen seconds bucket. 1 unit = ~6.7s at V4.
//                         50 → 10 × 30-second videos OR 5 × 60-sec
//                         100 → 20 × 30-second OR 10 × 60-sec
//                         250 → 50 × 30-second OR 27 × 60-sec
//   limits              — feature gates (active workflows, avatars per
//                         brand, looks per avatar) for the soft caps
//                         the schedule / spaces / avatars pages enforce
//   support             — what kind of support that tier gets, surfaced
//                         in the pricing UI as a feature row
export const TIERS = {
  solo_starter: {
    name: 'Solo Starter',
    profile_limit: 1,
    monthly_price_id: process.env.STRIPE_PRICE_SOLO_STARTER,
    annual_price_id:  process.env.STRIPE_PRICE_SOLO_STARTER_ANNUAL,
    monthly_usd: 49,
    annual_usd:  468,
    credits: { ai_tokens: 100_000, video_units: 50, voice_minutes: 0 },
    limits: {
      active_workflows: 3,
      avatars_per_profile: 1,
      looks_per_avatar: 3,
      public_templates: false,
    },
    support: 'Email support',
    description: 'For solopreneurs starting out. 10 × 30-second avatar videos / month.',
  },
  solo_pro: {
    name: 'Solo Pro',
    profile_limit: 2,
    monthly_price_id: process.env.STRIPE_PRICE_SOLO_PRO,
    annual_price_id:  process.env.STRIPE_PRICE_SOLO_PRO_ANNUAL,
    monthly_usd: 89,
    annual_usd:  890,
    credits: { ai_tokens: 500_000, video_units: 100, voice_minutes: 0 },
    limits: {
      active_workflows: 10,
      avatars_per_profile: 3,
      looks_per_avatar: 6,
      public_templates: true,
    },
    support: 'Priority chat + email',
    description: 'The everything plan most users land on. 20 × 30-second avatar videos / month.',
  },
  solo_studio: {
    name: 'Solo Studio',
    profile_limit: 5,
    monthly_price_id: process.env.STRIPE_PRICE_SOLO_STUDIO,
    annual_price_id:  process.env.STRIPE_PRICE_SOLO_STUDIO_ANNUAL,
    monthly_usd: 229,
    annual_usd:  2290,
    credits: { ai_tokens: 2_000_000, video_units: 250, voice_minutes: 0 },
    limits: {
      active_workflows: 50,
      avatars_per_profile: 10,
      looks_per_avatar: 12,
      public_templates: true,
    },
    support: 'Discord + priority chat + 1:1 onboarding call',
    description: 'Multi-brand creators and agencies. 50 × 30-second avatar videos / month.',
  },
  founding: {
    name: 'Founding Member',
    profile_limit: 2,
    monthly_price_id: process.env.STRIPE_PRICE_FOUNDING,
    annual_price_id:  process.env.STRIPE_PRICE_FOUNDING_ANNUAL,
    monthly_usd: 69,
    annual_usd:  690,
    lifetime_lock: true,
    credits: { ai_tokens: 500_000, video_units: 100, voice_minutes: 0 },
    limits: {
      active_workflows: 10,
      avatars_per_profile: 3,
      looks_per_avatar: 6,
      public_templates: true,
    },
    support: 'Priority chat + email + founding-member Discord',
    description: 'Solo Pro at $20/mo off — locked for life. 100 spots only.',
  },
}

// Trial caps — server-enforced on every avatar render and polish
// step when the user's subscription is in 'trialing' status. Keeps
// HeyGen cost-per-trial bounded:
//   - V4 only (we removed V3 / V5 entirely; this is just defensive)
//   - 30-second hard cap on duration
//   - ScaleSolo watermark, bottom-center-above-UI position, can't
//     be changed by the user
//   - 1 video allowance enforced via the 5-credit trial grant
// SVG sits in the public sm_icons bucket so it's directly usable as
// a watermark image URL — sharp can fetch it like any logo.
export const TRIAL_LOCKS = {
  forced_model: 'v4',
  max_duration_secs: 30,
  forced_watermark_url: 'https://vbvmfiepwyxlfafbwtkb.supabase.co/storage/v1/object/public/sm_icons/scalesolo%20logo.svg',
  forced_watermark_position: 'bc-safe',
  forced_watermark_size_pct: 22,
  trial_video_credits: 5,           // 1 × 30-second V4 render
  trial_ai_tokens: 5_000,
}

// Cheap "is this user on a trial right now" check. Reads
// billing_subscriptions.status — 'trialing' is the only state that
// triggers the locks. Called from avatar render + polish endpoints
// so the gating is consistent regardless of which surface kicks off
// the work.
//
// Returns true on trial, false otherwise. Service-role auth assumed
// — the caller already passed requireUser.
export async function isUserOnTrial(userId) {
  if (!userId) return false
  try {
    const cust = await (await import('./supabase.js')).supaFetch(
      `billing_customers?user_id=eq.${userId}&select=id`
    )
    const customerId = cust?.[0]?.id
    if (!customerId) return false
    const subs = await (await import('./supabase.js')).supaFetch(
      `billing_subscriptions?customer_id=eq.${customerId}&order=created_at.desc&limit=1&select=status`
    )
    return subs?.[0]?.status === 'trialing'
  } catch {
    return false
  }
}

export function tierForPriceId(priceId) {
  if (!priceId) return null
  for (const [tier, def] of Object.entries(TIERS)) {
    if (def.monthly_price_id === priceId || def.annual_price_id === priceId) return tier
  }
  return null
}

export function billingCycleForPriceId(priceId) {
  if (!priceId) return 'monthly'
  for (const def of Object.values(TIERS)) {
    if (def.monthly_price_id === priceId) return 'monthly'
    if (def.annual_price_id === priceId)  return 'annual'
  }
  return 'monthly'
}

export function profileLimitForTier(tier) {
  return TIERS[tier]?.profile_limit ?? 1
}
