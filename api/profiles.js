import { setCors, requireUser, supaFetch, assertProfileAccess, isAdminUser } from './_lib/supabase.js'
import { indexBrandBible } from './_lib/embeddings.js'
import { TIERS, profileLimitForTier } from './_lib/billing.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return
  const userId = auth.user.id

  try {
    if (req.method === 'GET') {
      const access = await supaFetch(
        `profile_access?user_id=eq.${userId}&select=role,allowed_pages,profile:profiles(*)`
      )
      const list = (access || []).map((row) => ({ ...(row.profile || {}), role: row.role, allowed_pages: row.allowed_pages }))
      return res.status(200).json({ profiles: list })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.business_name) return res.status(400).json({ error: 'business_name required' })

      // Tier-gate brand profile creation. Each tier has a profile_limit
      // (Starter=1, Pro=2, Studio=5, Founding=2). We compare against the
      // user's CURRENT owned-profile count and refuse to create if it
      // would exceed the limit.
      //
      // Error shape:
      //   error    — friendly user-facing message ("Upgrade to add more
      //              brand profiles."). This is the message a regular
      //              user sees in toasts / form errors.
      //   detail   — admin-only diagnostic ("Limit of N profiles for
      //              plan X."). Only attached when the caller is an
      //              admin so the dev tools network panel doesn't leak
      //              plan names / numbers to end users debugging in
      //              their own browser.
      try {
        const cust = await supaFetch(`billing_customers?user_id=eq.${userId}&select=id`)
        const customerId = cust?.[0]?.id || null
        let tier = null
        if (customerId) {
          const subs = await supaFetch(`billing_subscriptions?customer_id=eq.${customerId}&order=created_at.desc&limit=1&select=tier,status`)
          const sub = subs?.[0]
          // Only honor a tier if the subscription is currently
          // money-good: trialing / active / past_due. Cancelled or
          // unpaid subs revert the user to the floor (Solo Starter).
          if (sub && ['trialing','active','past_due'].includes(sub.status)) {
            tier = sub.tier
          }
        }
        const effectiveTier = tier || 'solo_starter'
        const limit = profileLimitForTier(effectiveTier)
        const owned = await supaFetch(`profile_access?user_id=eq.${userId}&role=eq.owner&select=profile_id`)
        const ownedCount = Array.isArray(owned) ? owned.length : 0
        if (ownedCount >= limit) {
          const tierName = TIERS[effectiveTier]?.name || effectiveTier
          const friendly = limit === 1
            ? 'Your current plan includes one brand profile. Upgrade to add more.'
            : `Your current plan caps brand profiles at ${limit}. Upgrade to add more.`
          const payload = { error: friendly, code: 'profile_limit_reached' }
          // Admin-only detail (matches the message format the user asked
          // to be admin-side-only): "limit of N profiles for plan <tier>".
          if (await isAdminUser(auth)) {
            payload.detail = `Limit of ${limit} profiles for plan ${tierName} (${effectiveTier}); user owns ${ownedCount}.`
          }
          return res.status(402).json(payload)
        }
      } catch (limitErr) {
        // If the limit check itself fails (e.g. DB hiccup), fail open
        // rather than blocking a paying user. The next sync will catch
        // any over-limit profiles for cleanup.
        console.warn('[profiles] profile-limit check failed:', limitErr.message)
      }

      // Whitelist what we let through on create. Mirrors PATCH so the
      // onboarding survey can hand us a brand_bible / target_audience /
      // tone all at once and have them stick. Anything else is dropped.
      const ALLOWED = new Set([
        'business_name','industry','business_type','website_url','owner_name',
        'brand_bible','brand_bible_summary','brand_cta',
        'brand_primary_color','brand_secondary_color','logo_url',
        'preferred_tone','target_audience','core_hashtags',
        'do_not_say','always_include','default_formats',
        'timezone','synced_platforms','posting_schedule',
        'instagram_handle','tiktok_handle','facebook_handle','threads_handle',
        'youtube_handle','linkedin_handle','x_handle',
        'instagram_id','tiktok_id','facebook_id','threads_id','youtube_id','linkedin_id',
        'uploadpost_user','uploadpost_platforms',
      ])
      const insertRow = { is_active: true }
      for (const [k, v] of Object.entries(body)) {
        if (ALLOWED.has(k) && v !== undefined) insertRow[k] = v
      }
      // Cap brand_bible to 60k chars defensively. The column is text
      // (no hard limit) but a runaway paste shouldn't bloat the row.
      if (typeof insertRow.brand_bible === 'string') {
        insertRow.brand_bible = insertRow.brand_bible.slice(0, 60000)
      }
      const created = await supaFetch('profiles', {
        method: 'POST',
        body: insertRow,
      })
      const profile = Array.isArray(created) ? created[0] : created
      await supaFetch('profile_access', {
        method: 'POST',
        body: {
          user_id: userId,
          profile_id: profile.id,
          role: 'owner',
          allowed_pages: ['*'],
        },
      })
      // Kick off the brand-bible embedding index in the background so
      // the AI can semantically pull the right chunk into prompts. Don't
      // block the response — best-effort, retriable via /api/agent/index-brand-bible.
      if (insertRow.brand_bible) {
        indexBrandBible(profile.id, insertRow.brand_bible).catch((err) => {
          console.warn('[profiles] new-profile brand bible index failed:', err.message)
        })
      }
      return res.status(201).json({ profile })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id || (req.body && req.body.id)
      if (!id) return res.status(400).json({ error: 'id required' })
      const role = await assertProfileAccess(userId, id)
      if (!['owner', 'admin'].includes(role)) return res.status(403).json({ error: 'Forbidden' })
      // Whitelist columns that are safe to PATCH on profiles. Anything else
      // (incl. context-side helpers like _role / _allowed_pages, and joined
      // access cols) is silently dropped.
      const ALLOWED = new Set([
        'business_name','owner_name','industry','business_type','website_url',
        'brand_bible','brand_bible_summary','brand_cta','brand_primary_color','brand_secondary_color',
        'do_not_say','always_include','default_formats',
        'brand_colors','brand_fonts','logo_url',
        'timezone','synced_platforms','posting_schedule',
        'preferred_tone','target_audience','core_hashtags','location','timezone',
        'instagram_handle','tiktok_handle','facebook_handle','threads_handle',
        'youtube_handle','linkedin_handle','x_handle',
        'instagram_id','tiktok_id','facebook_id','threads_id','youtube_id','linkedin_id',
        'uploadpost_user','uploadpost_platforms','autodm_reply_message',
        'carousel_templates','threads_style','enabled_pages',
        'agent_aggressiveness','is_active',
      ])
      const updates = {}
      for (const [k, v] of Object.entries(req.body || {})) {
        if (k === 'id') continue
        if (ALLOWED.has(k)) updates[k] = v
      }
      const brandBibleChanged = Object.prototype.hasOwnProperty.call(updates, 'brand_bible')
      const updated = await supaFetch(`profiles?id=eq.${id}`, {
        method: 'PATCH',
        body: updates,
      })
      const profile = Array.isArray(updated) ? updated[0] : updated
      // Re-embed brand bible chunks if it changed. Don't fail the save on
      // embedding errors — users can manually retrigger via /api/agent/index-brand-bible.
      if (brandBibleChanged) {
        indexBrandBible(id, profile?.brand_bible || '').catch((err) => {
          console.warn('[profiles] brand bible reindex failed:', err.message)
        })
      }
      return res.status(200).json({ profile })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const role = await assertProfileAccess(userId, id)
      if (role !== 'owner') return res.status(403).json({ error: 'Owner only' })
      await supaFetch(`profiles?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
