// GET /api/contact-activity?contact_id=... | ?profile_id=...
// Reads the activity timeline for a single contact OR all activity in a profile.

import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const contactId = req.query.contact_id
    const profileId = req.query.profile_id
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50)

    let path
    if (contactId) {
      // Find profile_id for access check
      const rows = await supaFetch(`email_contacts?id=eq.${contactId}&select=profile_id`)
      const profileIdLookup = rows?.[0]?.profile_id
      if (!profileIdLookup) return res.status(404).json({ error: 'Contact not found' })
      await assertProfileAccess(auth.user.id, profileIdLookup)
      path = `contact_activity?contact_id=eq.${contactId}&order=occurred_at.desc&limit=${limit}&select=*`
    } else if (profileId) {
      await assertProfileAccess(auth.user.id, profileId)
      path = `contact_activity?profile_id=eq.${profileId}&order=occurred_at.desc&limit=${limit}&select=*,contact:email_contacts(id,email,name)`
    } else {
      return res.status(400).json({ error: 'contact_id or profile_id required' })
    }

    const events = await supaFetch(path)
    return res.status(200).json({ events: events || [] })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
