// POST /api/spaces/run-now
// Body: { space_id, profile_id, graph: { nodes, edges } }
// Returns: { ok: true, dispatched: true }
//
// Dispatches a one-shot workflow run to the Fly worker — same path
// the cron uses for scheduled auto_run, but kicked off by a manual
// Run-button click. The browser can close the tab immediately after
// this returns; the worker carries the run to completion and writes
// space_runs / content_scripts rows from its end.
//
// The browser still receives realtime updates via supabase
// postgres_changes on space_runs, so the canvas's run state can
// reflect progress when the user is on the page — and seamlessly
// "catch up" when they come back to a tab they closed.
//
// Auth: real user JWT. We re-verify access to the profile before
// dispatching so a stolen graph payload can't run against someone
// else's profile. The worker call uses an internal-secret bypass to
// impersonate the caller end-to-end.

import { setCors, requireUser, assertProfileAccess } from '../_lib/supabase.js'

export const config = { maxDuration: 30 }

const WORKER_URL = process.env.WORKER_URL
const WORKER_SECRET = process.env.WORKER_SHARED_SECRET
const INTERNAL_SECRET = process.env.WORKFLOW_INTERNAL_SECRET

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { space_id, profile_id, graph } = req.body || {}
    if (!space_id || !profile_id) {
      return res.status(400).json({ error: 'space_id + profile_id required' })
    }
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      return res.status(400).json({ error: 'graph.nodes + graph.edges required' })
    }
    if (!WORKER_URL || !INTERNAL_SECRET) {
      return res.status(500).json({ error: 'Worker not configured (WORKER_URL / WORKFLOW_INTERNAL_SECRET)' })
    }
    await assertProfileAccess(auth.user.id, profile_id)

    // Fire-and-forget intent. The worker writes a space_runs row on
    // its end, so a delayed/dropped response here doesn't leave the
    // canvas in the dark — Supabase realtime picks it up.
    const wRes = await fetch(`${WORKER_URL.replace(/\/$/, '')}/jobs/run-workflow`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WORKER_SECRET ? { 'x-worker-secret': WORKER_SECRET } : {}),
      },
      body: JSON.stringify({
        // No schedule_id — this is a one-shot manual run, not a cron tick.
        user_id: auth.user.id,
        profile_id,
        space_id,
        // trigger_node_id is purely cosmetic in the worker (it's
        // logged on the space_runs row for cron-fired runs). Manual
        // dispatches don't have one; the worker tolerates a missing
        // value and labels the row with triggered_by="manual_server".
        trigger_node_id: null,
        graph,
        internal_secret: INTERNAL_SECRET,
        triggered_by: 'manual_server',
      }),
    })
    const wBody = await wRes.json().catch(() => ({}))
    if (!wRes.ok) {
      return res.status(502).json({ error: wBody?.error || `Worker ${wRes.status}` })
    }
    return res.status(200).json({ ok: true, dispatched: true, job_id: wBody?.job_id || null })
  } catch (err) {
    console.error('run-now error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
