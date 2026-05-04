// /api/content — CRUD for content_scripts.
//   GET ?profile_id=...&filter=library|drafts|scheduled|approvals|posted
//   GET ?id=...
//   POST { profile_id, ... }
//   PATCH ?id=... { ... }
//   DELETE ?id=...
//
// Special POSTs:
//   POST ?action=approve   ?id=...                 → approval_status=approved
//   POST ?action=reject    ?id=...  { reason? }    → approval_status=rejected
//   POST ?action=schedule  ?id=...  { scheduled_datetime, platforms? }

import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'

const ALLOWED = new Set([
  'title','hook','full_script','series_name','caption','hashtags','first_comment',
  'tags','media_urls','media_type','scheduled_datetime','status','sort_order',
  'post_type','location','platforms','cover_timestamp',
  'needs_approval','approval_status','rejected_reason','recycle_period_days',
  'generated_by','generation_prompt','performance',
])

function pickAllowed(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) if (ALLOWED.has(k)) out[k] = v
  return out
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const id = req.query.id
      if (id) {
        const rows = await supaFetch(`content_scripts?id=eq.${id}&select=*`)
        const item = rows?.[0]
        if (!item) return res.status(404).json({ error: 'Not found' })
        await assertProfileAccess(auth.user.id, item.profile_id)
        return res.status(200).json({ item })
      }
      const profileId = req.query.profile_id
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)

      const filter = req.query.filter || 'library'
      let where = `profile_id=eq.${profileId}`
      if (filter === 'drafts')    where += '&status=eq.draft'
      if (filter === 'caption_ready') where += '&status=eq.caption_ready'
      if (filter === 'scheduled') where += '&status=eq.scheduled'
      if (filter === 'posted')    where += '&status=eq.posted'
      if (filter === 'approvals') where += '&approval_status=eq.pending'
      const order = filter === 'scheduled' ? 'scheduled_datetime.asc' : 'updated_at.desc'
      const rows = await supaFetch(`content_scripts?${where}&order=${order}&limit=200&select=*`)
      return res.status(200).json({ items: rows || [] })
    }

    if (req.method === 'POST') {
      const action = req.query.action
      const id = req.query.id

      // ── Approve / reject / schedule actions ─────────────────────────────
      if (action && id) {
        const rows = await supaFetch(`content_scripts?id=eq.${id}&select=profile_id,status`)
        const item = rows?.[0]
        if (!item) return res.status(404).json({ error: 'Not found' })
        await assertProfileAccess(auth.user.id, item.profile_id)

        let updates = {}
        if (action === 'approve') {
          updates = {
            approval_status: 'approved',
            needs_approval: false,
            approved_by: auth.user.id,
            approved_at: new Date().toISOString(),
            rejected_reason: null,
            // Move out of 'caption_ready' into 'scheduled' or 'draft' depending on whether scheduled_datetime exists
            status: item.status === 'caption_ready' ? 'caption_ready' : item.status,
          }
        } else if (action === 'reject') {
          updates = {
            approval_status: 'rejected',
            needs_approval: false,
            approved_by: auth.user.id,
            approved_at: new Date().toISOString(),
            rejected_reason: req.body?.reason || null,
          }
        } else if (action === 'schedule') {
          if (!req.body?.scheduled_datetime) return res.status(400).json({ error: 'scheduled_datetime required' })
          updates = {
            scheduled_datetime: req.body.scheduled_datetime,
            status: 'scheduled',
            platforms: req.body.platforms || null,
          }
        } else {
          return res.status(400).json({ error: `unknown action: ${action}` })
        }

        const updated = await supaFetch(`content_scripts?id=eq.${id}`, { method: 'PATCH', body: updates })
        return res.status(200).json({ item: Array.isArray(updated) ? updated[0] : updated })
      }

      // ── Plain create ────────────────────────────────────────────────────
      const body = req.body || {}
      if (!body.profile_id) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, body.profile_id)
      const row = pickAllowed(body)
      row.profile_id = body.profile_id
      const created = await supaFetch('content_scripts', { method: 'POST', body: row })
      return res.status(201).json({ item: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id || req.body?.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`content_scripts?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      const updates = pickAllowed(req.body || {})
      const updated = await supaFetch(`content_scripts?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ item: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`content_scripts?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      await supaFetch(`content_scripts?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
