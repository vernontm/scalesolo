// POST /api/spaces/cancel-run
// Body: { space_run_id }
// Returns: { ok: true, cancelled: true } | { ok: true, already_finished: true }
//
// Marks an active space_runs row as 'cancelled' so the worker bails out
// at the next node boundary instead of grinding through the remaining
// graph after the user clicked Stop. The worker re-reads space_runs.status
// between every node (see worker/workflow-runner.js); finding 'cancelled'
// makes it throw a CancelledError that the run-workflow handler treats as
// terminal.
//
// Auth: real user JWT. Profile access is verified by ownership of the
// space the run belongs to — we don't trust an arbitrary run id from the
// caller without checking it maps to a space they can touch.

import { setCors, requireUser, supaFetch } from '../_lib/supabase.js'

export const config = { maxDuration: 15 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST')     return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { space_run_id } = req.body || {}
    if (!space_run_id) return res.status(400).json({ error: 'space_run_id required' })

    // Look up the run + its space ownership in one round-trip. Reject any
    // run that doesn't belong to a space the caller can access.
    const rows = await supaFetch(
      `space_runs?id=eq.${encodeURIComponent(space_run_id)}` +
      `&select=id,status,space_id,profile_id`
    )
    const row = rows?.[0]
    if (!row) return res.status(404).json({ error: 'Run not found' })

    // Profile-level access check (mirrors what assertProfileAccess does
    // for endpoints that already have a profile_id in hand).
    if (row.profile_id) {
      try {
        const { assertProfileAccess } = await import('../_lib/supabase.js')
        await assertProfileAccess(auth.user.id, row.profile_id)
      } catch (e) {
        return res.status(403).json({ error: 'Not authorized for this run' })
      }
    }

    // Already-terminal states are a no-op (200, not 4xx — the user's
    // intent was achieved even if the row had moved on by the time we
    // got the click).
    if (['success', 'failed', 'cancelled', 'partial'].includes(row.status)) {
      return res.status(200).json({ ok: true, already_finished: true, status: row.status })
    }

    await supaFetch(`space_runs?id=eq.${encodeURIComponent(space_run_id)}`, {
      method: 'PATCH',
      body: {
        status: 'cancelled',
        finished_at: new Date().toISOString(),
        errors: [{ msg: 'Cancelled by user' }],
      },
      prefer: 'return=minimal',
    })

    return res.status(200).json({ ok: true, cancelled: true })
  } catch (err) {
    console.error('cancel-run error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
