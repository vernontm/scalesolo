// POST /api/stripe-link-session
// Body: { session_id }
// Auth required.
//
// Called by the signup page after the user finishes account creation
// in the public-checkout-first flow. Links the Stripe customer
// (created during anonymous checkout) to the user's Supabase user_id
// by patching billing_customers.user_id. The webhook may have
// already created the billing_customers row with user_id=null — this
// endpoint fills it in. If the row doesn't exist yet (webhook hasn't
// fired), we create it.

import { setCors, requireUser, supaFetch } from './_lib/supabase.js'
import * as stripe from './_lib/stripe.js'

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

    const session = await stripe.call('GET', `/checkout/sessions/${encodeURIComponent(session_id)}?expand[]=customer&expand[]=subscription`)
    if (!session) return res.status(404).json({ error: 'session not found' })

    const stripeCustomerId = typeof session.customer === 'string' ? session.customer : session?.customer?.id
    if (!stripeCustomerId) return res.status(400).json({ error: 'session has no customer' })

    // Lock the billing_customer to this user. Two paths:
    //   - Row already exists (webhook upserted it on subscription.created):
    //     patch user_id + email so the user can sign in and see their plan.
    //   - Row doesn't exist yet: create it, the webhook will find it
    //     by stripe_customer_id on the next event and update status.
    const existing = await supaFetch(`billing_customers?stripe_customer_id=eq.${encodeURIComponent(stripeCustomerId)}&select=id,user_id`)
    const existingRow = existing?.[0]
    if (existingRow) {
      if (existingRow.user_id && existingRow.user_id !== auth.user.id) {
        // Already linked to a different account — refuse to overwrite.
        return res.status(409).json({ error: 'This Stripe customer is already linked to another account.' })
      }
      await supaFetch(`billing_customers?id=eq.${existingRow.id}`, {
        method: 'PATCH',
        body: { user_id: auth.user.id, email: session?.customer_details?.email || auth.user.email },
        prefer: 'return=minimal',
      })
      return res.status(200).json({ ok: true, customer_id: existingRow.id, linked: 'existing' })
    }

    const created = await supaFetch('billing_customers', {
      method: 'POST',
      body: {
        user_id: auth.user.id,
        email: session?.customer_details?.email || auth.user.email,
        stripe_customer_id: stripeCustomerId,
      },
    })
    const row = Array.isArray(created) ? created[0] : created
    return res.status(201).json({ ok: true, customer_id: row?.id, linked: 'created' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
