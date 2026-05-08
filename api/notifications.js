// /api/notifications — read + mark-read for the authenticated user.
//   GET                          → list latest 50 (most recent first)
//   GET ?unread=1                → unread only (for the bell badge)
//   POST ?action=read&id=...     → mark one notification read
//   POST ?action=read_all        → mark every unread notification read
//   DELETE ?id=...               → delete a notification
//
// Inserts come from the server (notify.js) — there is no public POST.
// RLS scopes everything to the caller's auth.uid(), so a leaked service
// path can't expose someone else's notifications.

import { setCors, requireUser, supaFetch } from './_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const filters = [`user_id=eq.${auth.user.id}`]
      if (req.query.unread === '1') filters.push('read_at=is.null')
      filters.push('order=created_at.desc')
      filters.push('limit=50')
      const rows = await supaFetch(`notifications?${filters.join('&')}&select=*`)
      // Cheap unread count for the badge — saves a second round trip.
      const unread = req.query.unread === '1'
        ? rows.length
        : rows.filter((r) => !r.read_at).length
      return res.status(200).json({ notifications: rows || [], unread })
    }

    if (req.method === 'POST') {
      const action = req.query.action
      const now = new Date().toISOString()
      if (action === 'read') {
        const id = req.query.id
        if (!id) return res.status(400).json({ error: 'id required' })
        const updated = await supaFetch(
          `notifications?id=eq.${id}&user_id=eq.${auth.user.id}`,
          { method: 'PATCH', body: { read_at: now } }
        )
        return res.status(200).json({ notification: Array.isArray(updated) ? updated[0] : updated })
      }
      if (action === 'read_all') {
        await supaFetch(
          `notifications?user_id=eq.${auth.user.id}&read_at=is.null`,
          { method: 'PATCH', body: { read_at: now }, prefer: 'return=minimal' }
        )
        return res.status(200).json({ ok: true })
      }
      return res.status(400).json({ error: `unknown action: ${action}` })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      await supaFetch(
        `notifications?id=eq.${id}&user_id=eq.${auth.user.id}`,
        { method: 'DELETE', prefer: 'return=minimal' }
      )
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
