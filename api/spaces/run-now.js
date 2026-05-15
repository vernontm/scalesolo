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

// 60s gives a cold-starting Railway / Fly worker enough time to come up
// from auto-sleep. Hot workers ack in <1s; cold starts can take 20-40s
// on the first request after idle. 30s was just enough to time out on
// every cold start.
export const config = { maxDuration: 60 }

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
    const { space_id, profile_id, graph, run_only_target_id, rerun_from_node_id } = req.body || {}
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
    //
    // AbortController-bounded fetch so we get a clear timeout error
    // instead of Vercel's opaque 504 gateway page. 45s leaves headroom
    // under maxDuration=60. Hot workers ack in <1s; cold workers ack in
    // 10-30s; >45s means the worker is genuinely down.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 45_000)
    const t0 = Date.now()
    let wRes
    try {
      wRes = await fetch(`${WORKER_URL.replace(/\/$/, '')}/jobs/run-workflow`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(WORKER_SECRET ? { 'x-worker-secret': WORKER_SECRET } : {}),
        },
        body: JSON.stringify({
          user_id: auth.user.id,
          profile_id,
          space_id,
          trigger_node_id: null,
          graph,
          internal_secret: INTERNAL_SECRET,
          triggered_by: 'manual_server',
          // Multi-clip per-node Run support — when set, worker only
          // re-runs this node and uses cached outputs for everything
          // else. Spaces.jsx routes the Run-this-node button to the
          // server with this id for any workflow that has multi-clip
          // data, so we don't get FUNCTION_INVOCATION_FAILED on
          // browser-orchestrated parallel polish.
          run_only_target_id: run_only_target_id || null,
          rerun_from_node_id: rerun_from_node_id || null,
        }),
        signal: controller.signal,
      })
    } catch (e) {
      clearTimeout(timeout)
      const ms = Date.now() - t0
      if (e?.name === 'AbortError') {
        console.error(`run-now: worker timed out after ${ms}ms`, { WORKER_URL })
        return res.status(504).json({
          error: `Worker timed out after ${(ms / 1000).toFixed(0)}s. The render worker is either cold-starting from sleep or unreachable. Retry in a moment — once it warms up, subsequent runs are instant.`,
          worker_url: WORKER_URL,
          elapsed_ms: ms,
        })
      }
      console.error(`run-now: worker fetch failed after ${ms}ms`, e?.stack || e)
      return res.status(502).json({
        error: `Could not reach worker: ${e?.message || e}`,
        worker_url: WORKER_URL,
      })
    }
    clearTimeout(timeout)
    const dispatchMs = Date.now() - t0
    if (dispatchMs > 5_000) {
      console.warn(`run-now: slow worker ack — ${dispatchMs}ms`)
    }
    const wBody = await wRes.json().catch(() => ({}))
    if (!wRes.ok) {
      return res.status(502).json({ error: wBody?.error || `Worker ${wRes.status}`, dispatch_ms: dispatchMs })
    }
    return res.status(200).json({ ok: true, dispatched: true, job_id: wBody?.job_id || null, dispatch_ms: dispatchMs })
  } catch (err) {
    console.error('run-now error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
