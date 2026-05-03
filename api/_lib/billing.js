// Tier catalog. Lives in code (not DB) so it's version-controlled.

export const TIERS = {
  solo_starter: {
    name: 'Solo Starter',
    profile_limit: 1,
    monthly_price_id: process.env.STRIPE_PRICE_SOLO_STARTER,
    annual_price_id:  process.env.STRIPE_PRICE_SOLO_STARTER_ANNUAL,
    monthly_usd: 49,
    annual_usd:  490,
    credits: { ai_tokens: 100_000, video_units: 10, voice_minutes: 0 },
    description: 'For solopreneurs starting out.',
  },
  solo_pro: {
    name: 'Solo Pro',
    profile_limit: 2,
    monthly_price_id: process.env.STRIPE_PRICE_SOLO_PRO,
    annual_price_id:  process.env.STRIPE_PRICE_SOLO_PRO_ANNUAL,
    monthly_usd: 79,
    annual_usd:  790,
    credits: { ai_tokens: 500_000, video_units: 30, voice_minutes: 0 },
    description: 'The everything plan most users land on.',
  },
  solo_studio: {
    name: 'Solo Studio',
    profile_limit: 5,
    monthly_price_id: process.env.STRIPE_PRICE_SOLO_STUDIO,
    annual_price_id:  process.env.STRIPE_PRICE_SOLO_STUDIO_ANNUAL,
    monthly_usd: 149,
    annual_usd:  1490,
    credits: { ai_tokens: 2_000_000, video_units: 100, voice_minutes: 0 },
    description: 'Multi-brand creators and agencies of one.',
  },
  founding: {
    name: 'Founding Member',
    profile_limit: 2,
    monthly_price_id: process.env.STRIPE_PRICE_FOUNDING,
    annual_price_id:  null,
    monthly_usd: 39,
    annual_usd:  null,
    lifetime_lock: true,
    credits: { ai_tokens: 500_000, video_units: 30, voice_minutes: 0 },
    description: 'Lifetime price lock. 100 spots only.',
  },
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
