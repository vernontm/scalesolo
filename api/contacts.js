// /api/contacts — list / create / update / delete email_contacts.
// Routes the SPA's contact reads through a server-side endpoint so RLS isn't
// the only thing standing between an attacker and the contact list.
import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'

const ALLOWED = new Set([
  'email','name','phone','tags','status','source',
  'birthday_month','birthday_day','discount_code','city','state','country','signed_up_at','welcomed_at',
])

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const id = req.query.id
      if (id) {
        const rows = await supaFetch(`email_contacts?id=eq.${id}&select=*`)
        const c = rows?.[0]
        if (!c) return res.status(404).json({ error: 'Not found' })
        await assertProfileAccess(auth.user.id, c.profile_id)
        return res.status(200).json({ contact: c })
      }
      const profileId = req.query.profile_id
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)
      const search = (req.query.q || '').toString().trim()
      const limit = Math.min(500, parseInt(req.query.limit, 10) || 200)
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0)

      let where = `profile_id=eq.${profileId}`
      if (search) {
        // PostgREST: or=(email.ilike.*x*,name.ilike.*x*)
        const safe = encodeURIComponent(search.replace(/[%]/g, '').toLowerCase())
        where += `&or=(email.ilike.*${safe}*,name.ilike.*${safe}*)`
      }
      const rows = await supaFetch(
        `email_contacts?${where}&order=created_at.desc&limit=${limit}&offset=${offset}&select=id,email,name,phone,tags,status,source,created_at`
      )
      return res.status(200).json({ contacts: rows || [], limit, offset })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.profile_id || !body.email) return res.status(400).json({ error: 'profile_id + email required' })
      await assertProfileAccess(auth.user.id, body.profile_id)
      const row = { profile_id: body.profile_id }
      for (const [k, v] of Object.entries(body)) if (ALLOWED.has(k)) row[k] = v
      if (!row.signed_up_at) row.signed_up_at = new Date().toISOString()
      const created = await supaFetch('email_contacts', { method: 'POST', body: row })
      return res.status(201).json({ contact: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`email_contacts?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      const updates = {}
      for (const [k, v] of Object.entries(req.body || {})) if (ALLOWED.has(k)) updates[k] = v
      const updated = await supaFetch(`email_contacts?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ contact: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`email_contacts?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      await supaFetch(`email_contacts?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
