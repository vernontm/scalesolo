// Returns a Stripe Customer Portal URL for the signed-in user.
const { setCors, requireUser, supaFetch } = require('./_lib/supabase')
const stripe = require('./_lib/stripe')

const APP_URL = process.env.SCALESOLO_DOMAIN || process.env.FRONTEND_URL || 'https://scalesolo.app'

module.exports = async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const rows = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=stripe_customer_id`)
    const stripeCustId = rows?.[0]?.stripe_customer_id
    if (!stripeCustId) return res.status(404).json({ error: 'No Stripe customer for this account.' })

    const session = await stripe.createBillingPortalSession({
      customer: stripeCustId,
      return_url: `${APP_URL}/billing`,
    })
    return res.status(200).json({ url: session.url })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
