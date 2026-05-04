// Deals CRUD + drag-drop move endpoint.
//   GET    ?pipeline_id=...                 → all deals for a pipeline
//   POST   { pipeline_id, ... }             → create
//   PATCH  ?id=... { ... }                  → update
//   DELETE ?id=...                          → delete
//   POST   ?id=...&action=move { stage, position }
import { setCors, requireUser, supaFetch, assertProfileAccess } from './_lib/supabase.js'

async function logActivity(profileId, contactId, eventType, payload) {
  if (!contactId) return
  try {
    await supaFetch('rpc/log_activity', {
      method: 'POST',
      body: { p_profile_id: profileId, p_contact_id: contactId, p_event_type: eventType, p_payload: payload || {} },
    })
  } catch {}
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const pipelineId = req.query.pipeline_id
      if (!pipelineId) return res.status(400).json({ error: 'pipeline_id required' })
      // Look up profile_id for access check
      const pipe = await supaFetch(`pipelines?id=eq.${pipelineId}&select=profile_id`)
      const profileId = pipe?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Pipeline not found' })
      await assertProfileAccess(auth.user.id, profileId)
      const rows = await supaFetch(
        `deals?pipeline_id=eq.${pipelineId}&order=stage.asc,position.asc&select=*,contact:email_contacts(id,email,name)`
      )
      return res.status(200).json({ deals: rows || [] })
    }

    // Move action: POST /api/deals?id=...&action=move
    if (req.method === 'POST' && req.query.action === 'move') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const body = req.body || {}
      if (!body.stage) return res.status(400).json({ error: 'stage required' })
      const rows = await supaFetch(`deals?id=eq.${id}&select=profile_id,stage,contact_id,title`)
      const deal = rows?.[0]
      if (!deal) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, deal.profile_id)

      const updates = { stage: body.stage, position: body.position ?? 0 }
      // If transitioning to Won/Lost, stamp closed_at
      if (['Won', 'Lost', 'won', 'lost'].includes(body.stage)) {
        updates.closed_at = new Date().toISOString()
        if (body.win_loss_reason) updates.win_loss_reason = body.win_loss_reason
      } else {
        updates.closed_at = null
      }

      const updated = await supaFetch(`deals?id=eq.${id}`, { method: 'PATCH', body: updates })
      const deal2 = Array.isArray(updated) ? updated[0] : updated

      // Log to activity timeline if stage changed
      if (deal.stage !== body.stage) {
        await logActivity(deal.profile_id, deal.contact_id, 'deal_moved', {
          deal_id: id, title: deal.title, from: deal.stage, to: body.stage,
        })
      }
      return res.status(200).json({ deal: deal2 })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.pipeline_id || !body.title || !body.stage) {
        return res.status(400).json({ error: 'pipeline_id, title, stage required' })
      }
      const pipe = await supaFetch(`pipelines?id=eq.${body.pipeline_id}&select=profile_id`)
      const profileId = pipe?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Pipeline not found' })
      await assertProfileAccess(auth.user.id, profileId)
      const created = await supaFetch('deals', {
        method: 'POST',
        body: {
          profile_id: profileId,
          pipeline_id: body.pipeline_id,
          contact_id: body.contact_id || null,
          title: body.title,
          stage: body.stage,
          value: body.value ?? 0,
          expected_close_at: body.expected_close_at || null,
          notes: body.notes || null,
          custom_fields: body.custom_fields || {},
          position: body.position ?? 0,
        },
      })
      const deal = Array.isArray(created) ? created[0] : created
      if (deal.contact_id) {
        await logActivity(profileId, deal.contact_id, 'deal_created', {
          deal_id: deal.id, title: deal.title, stage: deal.stage, value: deal.value,
        })
      }
      return res.status(201).json({ deal })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`deals?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      const updates = { ...(req.body || {}) }
      delete updates.id
      const updated = await supaFetch(`deals?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ deal: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`deals?id=eq.${id}&select=profile_id`)
      const profileId = rows?.[0]?.profile_id
      if (!profileId) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, profileId)
      await supaFetch(`deals?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
