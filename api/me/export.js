// /api/me/export — GDPR-friendly user data export.
// GET → returns a JSON dump of everything we hold for the authenticated
// user across the major tables. Streams as a single downloadable file
// (Content-Disposition: attachment) so the user can save it locally.
//
// Intentionally returns only the user's own rows. Service-role REST
// reads bypass RLS, so we hard-filter every query by user_id /
// profile_access on each table.

import { setCors, requireUser, supaFetch } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  const userId = auth.user.id
  try {
    // Pull profile IDs the user has access to so we can fan out across
    // the per-profile content tables.
    const access = await supaFetch(`profile_access?user_id=eq.${userId}&select=profile_id,role`)
    const profileIds = access.map((a) => a.profile_id)
    const inList = (arr) => arr.length ? `(${arr.map((id) => encodeURIComponent(id)).join(',')})` : null

    const [profiles, contentScripts, avatars, spaces, billingCustomers, creditPools, creditTransactions, notifications] = await Promise.all([
      profileIds.length ? supaFetch(`profiles?id=in.${inList(profileIds)}&select=*`) : Promise.resolve([]),
      profileIds.length ? supaFetch(`content_scripts?profile_id=in.${inList(profileIds)}&select=*`) : Promise.resolve([]),
      profileIds.length ? supaFetch(`avatars?profile_id=in.${inList(profileIds)}&select=*`) : Promise.resolve([]),
      profileIds.length ? supaFetch(`spaces?profile_id=in.${inList(profileIds)}&select=*`) : Promise.resolve([]),
      supaFetch(`billing_customers?user_id=eq.${userId}&select=*`),
      Promise.resolve([]),
      Promise.resolve([]),
      supaFetch(`notifications?user_id=eq.${userId}&select=*&order=created_at.desc&limit=500`).catch(() => []),
    ])
    const customerIds = billingCustomers.map((c) => c.id)
    const [pools, transactions] = await Promise.all([
      customerIds.length ? supaFetch(`credit_pools?customer_id=in.${inList(customerIds)}&select=*`) : Promise.resolve([]),
      customerIds.length ? supaFetch(`credit_transactions?customer_id=in.${inList(customerIds)}&select=*&order=created_at.desc&limit=2000`) : Promise.resolve([]),
    ])

    const payload = {
      generated_at: new Date().toISOString(),
      user: {
        id: userId,
        email: auth.user.email,
      },
      profile_access: access,
      profiles,
      content_scripts: contentScripts,
      avatars,
      spaces,
      notifications,
      billing: {
        customers: billingCustomers,
        credit_pools: pools,
        credit_transactions: transactions,
      },
    }
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename="scalesolo-export-${userId}.json"`)
    return res.status(200).send(JSON.stringify(payload, null, 2))
  } catch (err) {
    console.error('me/export error:', err?.stack || err)
    return res.status(500).json({ error: err.message })
  }
}
