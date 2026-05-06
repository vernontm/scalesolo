// /api/spaces/runs
//   GET  ?space_id=...                     list recent runs (most recent first)
//   POST { space_id, status, ... }         record the start (or full record) of a run
//   PATCH ?id=...                          update an in-flight run when it completes

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'GET') {
      const space_id = req.query.space_id
      if (!space_id) return res.status(400).json({ error: 'space_id required' })

      const sp = await supaFetch(`spaces?id=eq.${space_id}&select=profile_id`)
      const profile_id = sp?.[0]?.profile_id
      if (!profile_id) return res.status(404).json({ error: 'Space not found' })
      await assertProfileAccess(auth.user.id, profile_id)

      const limit = Math.min(50, Number(req.query.limit) || 25)
      const rows = await supaFetch(
        `space_runs?space_id=eq.${space_id}&select=*&order=started_at.desc&limit=${limit}`
      )
      return res.status(200).json({ runs: rows || [] })
    }

    if (req.method === 'POST') {
      const { space_id, triggered_by, status, node_count, errors, outputs } = req.body || {}
      if (!space_id) return res.status(400).json({ error: 'space_id required' })
      const sp = await supaFetch(`spaces?id=eq.${space_id}&select=profile_id`)
      const profile_id = sp?.[0]?.profile_id
      if (!profile_id) return res.status(404).json({ error: 'Space not found' })
      await assertProfileAccess(auth.user.id, profile_id)

      const created = await supaFetch('space_runs', {
        method: 'POST',
        body: {
          space_id,
          profile_id,
          triggered_by: triggered_by || 'manual',
          status: status || 'running',
          node_count: node_count ?? 0,
          errors: errors ?? [],
          outputs: outputs ?? {},
        },
      })
      return res.status(201).json({ run: Array.isArray(created) ? created[0] : created })
    }

    if (req.method === 'PATCH') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`space_runs?id=eq.${id}&select=profile_id`)
      const profile_id = rows?.[0]?.profile_id
      if (!profile_id) return res.status(404).json({ error: 'Run not found' })
      await assertProfileAccess(auth.user.id, profile_id)

      const ALLOWED = new Set(['status', 'node_count', 'errors', 'outputs', 'duration_ms', 'finished_at'])
      const updates = {}
      for (const [k, v] of Object.entries(req.body || {})) if (ALLOWED.has(k)) updates[k] = v
      const updated = await supaFetch(`space_runs?id=eq.${id}`, { method: 'PATCH', body: updates })
      return res.status(200).json({ run: Array.isArray(updated) ? updated[0] : updated })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const rows = await supaFetch(`space_runs?id=eq.${id}&select=profile_id`)
      const profile_id = rows?.[0]?.profile_id
      if (!profile_id) return res.status(404).json({ error: 'Run not found' })
      await assertProfileAccess(auth.user.id, profile_id)
      await supaFetch(`space_runs?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
