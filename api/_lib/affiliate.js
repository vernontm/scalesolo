// Affiliate program helpers — tier rates, code generation, commission
// computation. Tier promotion happens through the admin UI, not
// automatically — we surface the trigger thresholds but a human still
// has to flip the bit (avoids gaming).

import { supaFetch } from './supabase.js'

// Commission rate per tier. Use numerics so the row stores something
// like 0.2000 not 20. Keep in sync with the tier_label below.
export const AFFILIATE_TIERS = {
  starter: { rate: 0.20, label: 'Starter (20%)', upgrade_at: 5  /* paying referrals */ },
  pro:     { rate: 0.35, label: 'Pro (35%)',     upgrade_at: 20 },
  elite:   { rate: 0.50, label: 'Elite (50%)',   upgrade_at: null },
}

export function rateForTier(tier) {
  return AFFILIATE_TIERS[tier]?.rate ?? AFFILIATE_TIERS.starter.rate
}

// Make a unique-ish slug from the user's email handle / name. We
// double-check uniqueness against the DB before returning it.
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 14)
}

export async function generateAffiliateCode({ user, displayName }) {
  const seed = slugify(displayName) || slugify((user.email || '').split('@')[0]) || 'ss'
  // Try a few candidates so two users named "alex" don't collide.
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? seed : `${seed}${Math.floor(100 + Math.random() * 9000)}`
    const existing = await supaFetch(`affiliates?code=eq.${encodeURIComponent(candidate)}&select=id`)
    if (!existing.length) return candidate
  }
  // Fallback random
  return `aff${Math.random().toString(36).slice(2, 10)}`
}

// Build the public affiliate URL the user shares. Pulls site origin from
// env so we don't hardcode the current domain.
export function affiliateLink(code) {
  const base = process.env.SITE_URL || 'https://scalesolo.ai'
  return `${base.replace(/\/$/, '')}/?ref=${encodeURIComponent(code)}`
}

// Look up the affiliate row that should be credited for a referred
// auth-user. Returns null if the user signed up organically.
export async function affiliateForReferredUser(userId) {
  const refs = await supaFetch(
    `affiliate_referrals?referred_user_id=eq.${userId}&select=affiliate_id,id`
  ).catch(() => [])
  if (!refs.length) return null
  const aff = await supaFetch(
    `affiliates?id=eq.${refs[0].affiliate_id}&select=*`
  ).catch(() => [])
  return aff[0] ? { ...aff[0], referral_id: refs[0].id } : null
}

// Update first_paid_at on the referral row when the user converts to a
// paid invoice. Idempotent — no-op if already set.
export async function markReferralPaid(referralId) {
  if (!referralId) return
  try {
    const rows = await supaFetch(`affiliate_referrals?id=eq.${referralId}&select=first_paid_at`)
    if (rows[0]?.first_paid_at) return
    await supaFetch(`affiliate_referrals?id=eq.${referralId}`, {
      method: 'PATCH',
      body: { first_paid_at: new Date().toISOString() },
      prefer: 'return=minimal',
    })
  } catch (e) {
    console.warn('markReferralPaid failed:', e.message)
  }
}
