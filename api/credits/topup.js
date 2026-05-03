// POST /api/credits/topup — body: { pack: 'ai_tokens_100k' }
// Creates a one-off Stripe Checkout Session for the requested top-up pack.
// On payment, the webhook handler grants credits via grant_credits RPC.

import { setCors, requireUser, supaFetch } from '../_lib/supabase.js'
import * as stripe from '../_lib/stripe.js'
import { TOPUP_PACKS } from '../_lib/credits.js'

const APP_URL = process.env.SCALESOLO_DOMAIN || process.env.FRONTEND_URL || 'https://scalesolo.app'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { pack: packKey } = req.body || {}
    const pack = TOPUP_PACKS[packKey]
    if (!pack) return res.status(400).json({ error: `Unknown pack: ${packKey}` })
    if (!pack.priceId) return res.status(503).json({ error: `Top-up pack "${pack.label}" not yet priced. Add STRIPE_PRICE_TOPUP_* env var.` })

    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id,stripe_customer_id,email`)
    let customerRow = cust?.[0]
    if (!customerRow) {
      const created = await supaFetch('billing_customers', {
        method: 'POST',
        body: { user_id: auth.user.id, email: auth.user.email },
      })
      customerRow = Array.isArray(created) ? created[0] : created
    }
    if (!customerRow.stripe_customer_id) {
      const stripeCust = await stripe.createCustomer(
        { email: auth.user.email, metadata: { supabase_user_id: auth.user.id, scalesolo_customer_id: customerRow.id } },
        { idempotencyKey: `cust-${customerRow.id}` }
      )
      await supaFetch(`billing_customers?id=eq.${customerRow.id}`, {
        method: 'PATCH',
        body: { stripe_customer_id: stripeCust.id },
      })
      customerRow.stripe_customer_id = stripeCust.id
    }

    const session = await stripe.createCheckoutSession({
      mode: 'payment',
      customer: customerRow.stripe_customer_id,
      line_items: [{ price: pack.priceId, quantity: 1 }],
      success_url: `${APP_URL}/billing?topup=success`,
      cancel_url:  `${APP_URL}/billing?topup=cancel`,
      metadata: {
        kind: 'credit_topup',
        pack: packKey,
        pool: pack.pool,
        amount: String(pack.amount),
        scalesolo_customer_id: customerRow.id,
      },
    }, { idempotencyKey: `topup-${customerRow.id}-${packKey}-${Date.now()}` })

    return res.status(200).json({ url: session.url, session_id: session.id, pack: { ...pack, priceId: undefined } })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
