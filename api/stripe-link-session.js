// POST /api/stripe-link-session
// Body: { session_id }
// Auth required.
//
// Called by the signup page after the user finishes account creation
// in the public-checkout-first flow. Does THREE things, all idempotent:
//
//   1. Links the Stripe customer (created during anonymous checkout)
//      to the user's Supabase user_id by patching billing_customers.
//   2. Upserts the billing_subscriptions row from the session's
//      expanded subscription (so the app knows the user is trialing
//      even if the webhook is slow/down/misconfigured).
//   3. Grants trial credits (or full tier credits if the sub is already
//      active). Idempotent via grant_credits' ref_id check.
//
// Why duplicate the webhook's work here: webhooks fail. They get the
// wrong URL, the signing secret rotates, Vercel's cold start makes
// Stripe time out the request — every one of those has happened to us.
// This endpoint is the user's deterministic path: they paid, they
// signed up, they show up here, they get credited. No webhook
// dependency. The webhook still runs in parallel for renewals and
// status changes; the RPCs are all idempotent so double-execution is
// harmless.

import { setCors, requireUser, supaFetch } from './_lib/supabase.js'
import * as stripe from './_lib/stripe.js'
import { TIERS, tierForPriceId, billingCycleForPriceId } from './_lib/billing.js'

const TRIAL_GRANT = { ai_tokens: 5_000, video_units: 5, voice_minutes: 0 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { session_id } = req.body || {}
    if (!session_id || !/^cs_/.test(session_id)) {
      return res.status(400).json({ error: 'valid session_id required' })
    }

    const session = await stripe.call('GET', `/checkout/sessions/${encodeURIComponent(session_id)}?expand[]=customer&expand[]=subscription&expand[]=subscription.items.data.price`)
    if (!session) return res.status(404).json({ error: 'session not found' })

    const stripeCustomerId = typeof session.customer === 'string' ? session.customer : session?.customer?.id
    if (!stripeCustomerId) return res.status(400).json({ error: 'session has no customer' })

    // ── 1. Ensure billing_customers row exists and points at this user.
    let customerRowId
    const existing = await supaFetch(`billing_customers?stripe_customer_id=eq.${encodeURIComponent(stripeCustomerId)}&select=id,user_id`)
    const existingRow = existing?.[0]
    if (existingRow) {
      if (existingRow.user_id && existingRow.user_id !== auth.user.id) {
        return res.status(409).json({ error: 'This Stripe customer is already linked to another account.' })
      }
      await supaFetch(`billing_customers?id=eq.${existingRow.id}`, {
        method: 'PATCH',
        body: { user_id: auth.user.id, email: session?.customer_details?.email || auth.user.email },
        prefer: 'return=minimal',
      })
      customerRowId = existingRow.id
    } else {
      const created = await supaFetch('billing_customers', {
        method: 'POST',
        body: {
          user_id: auth.user.id,
          email: session?.customer_details?.email || auth.user.email,
          stripe_customer_id: stripeCustomerId,
        },
      })
      const row = Array.isArray(created) ? created[0] : created
      customerRowId = row?.id
    }

    if (!customerRowId) {
      return res.status(500).json({ error: 'Could not resolve billing_customers id' })
    }

    // ── 2. Upsert billing_subscriptions from the expanded subscription.
    const sub = session.subscription && typeof session.subscription === 'object' ? session.subscription : null
    let tier = null
    let cycle = 'monthly'
    if (sub) {
      const priceId = sub.items?.data?.[0]?.price?.id || null
      tier = tierForPriceId(priceId) || session?.metadata?.tier || null
      cycle = billingCycleForPriceId(priceId) || session?.metadata?.billing_cycle || 'monthly'
      const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
      const subRow = {
        customer_id: customerRowId,
        stripe_subscription_id: sub.id,
        status: sub.status,
        tier,
        billing_cycle: cycle,
        cancel_at_period_end: !!sub.cancel_at_period_end,
        current_period_end: periodEnd,
        trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
      }
      const subExisting = await supaFetch(`billing_subscriptions?stripe_subscription_id=eq.${encodeURIComponent(sub.id)}&select=id`)
      if (subExisting?.[0]) {
        await supaFetch(`billing_subscriptions?id=eq.${subExisting[0].id}`, {
          method: 'PATCH',
          body: subRow,
          prefer: 'return=minimal',
        })
      } else {
        await supaFetch('billing_subscriptions', {
          method: 'POST',
          body: subRow,
          prefer: 'return=minimal',
        })
      }
    }

    // ── 3. Grant credits (idempotent via ref_id on grant_credits RPC).
    if (sub && tier && TIERS[tier]) {
      const tierCredits = TIERS[tier].credits
      // Keep monthly_grant in sync so the renewal cron knows what to refill.
      await supaFetch('rpc/set_pool_grants', {
        method: 'POST',
        body: {
          p_customer_id: customerRowId,
          p_ai_tokens:   tierCredits.ai_tokens,
          p_video_units: tierCredits.video_units,
          p_voice_min:   tierCredits.voice_minutes,
        },
      }).catch((e) => console.warn('set_pool_grants failed:', e.message))

      const isTrial = sub.status === 'trialing'
      const initialGrant = isTrial ? TRIAL_GRANT : tierCredits
      await Promise.all(['ai_tokens','video_units','voice_minutes'].map((p) =>
        supaFetch('rpc/grant_credits', {
          method: 'POST',
          body: {
            p_customer_id: customerRowId,
            p_pool_type: p,
            p_amount: initialGrant[p] || 0,
            p_action: 'subscription_initial',
            p_ref_id: sub.id,
            p_metadata: { tier, trial: isTrial, source: 'link_session' },
          },
        }).catch((e) => console.warn(`initial grant ${p} failed:`, e.message))
      ))
    }

    return res.status(200).json({
      ok: true,
      customer_id: customerRowId,
      subscription_id: sub?.id || null,
      status: sub?.status || null,
      tier,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
