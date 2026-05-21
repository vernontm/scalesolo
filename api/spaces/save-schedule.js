// Persists / removes a server-side workflow schedule.
//
//   POST   /api/spaces/save-schedule
//     Body: {
//       space_id,
//       trigger_node_id,         // the auto_run node id firing this
//       profile_id,
//       interval_ms,
//       max_runs,
//       graph: { nodes, edges }, // snapshot of the canvas at activation
//     }
//     → { ok: true, id, next_fire_at }
//
//     Upserts a row in scheduled_workflows. next_fire_at is now + interval
//     on first save so the cron fires the first tick at the normal cadence
//     (matches browser auto-run behavior — the first tick fires 800ms after
//     the user clicks Start, but the second tick is interval later).
//
//   DELETE /api/spaces/save-schedule?space_id=…&trigger_node_id=…
//     → { ok: true }
//
//     Removes the row. Cron will stop firing this workflow.
//
//   GET    /api/spaces/save-schedule?space_id=…
//     → { schedules: [...] }
//
//     Returns active schedules for a space so the canvas can show
//     "server-scheduled" badges + reflect cron-side runs_used.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (req.method === 'POST') {
      const {
        space_id, trigger_node_id, profile_id,
        interval_ms, max_runs, graph,
      } = req.body || {}

      if (!space_id || !trigger_node_id || !profile_id) {
        return res.status(400).json({ error: 'space_id, trigger_node_id, profile_id required' })
      }
      if (!Number.isFinite(Number(interval_ms)) || Number(interval_ms) < 10_000) {
        return res.status(400).json({ error: 'interval_ms must be >= 10_000' })
      }
      if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        return res.status(400).json({ error: 'graph.nodes + graph.edges required' })
      }
      await assertProfileAccess(auth.user.id, profile_id)

      // First fire fires SOON — 60 seconds from now — so the user
      // gets visible feedback that the schedule works without
      // waiting a full interval. After the first run completes, the
      // cron advances next_fire_at by interval_ms on each subsequent
      // tick (so a "1 per day" schedule clicked at 1:18 PM fires:
      //   t+60s         (first, soon after activation)
      //   t+60s+24h     (second)
      //   t+60s+48h     (third)
      //   ...
      // ).
      //
      // 60s instead of 0 lets a misclick-Stop happen before any
      // credits burn. The cron runs every minute anyway so the
      // first fire generally happens within 60-120s of clicking
      // Start.
      const FIRST_FIRE_DELAY_MS = 60_000
      const nextFireAt = new Date(Date.now() + FIRST_FIRE_DELAY_MS).toISOString()

      const payload = {
        user_id: auth.user.id,
        profile_id,
        space_id,
        trigger_node_id,
        active: true,
        interval_ms: Number(interval_ms),
        // max_runs = 0 is the sentinel for "unlimited" (run until any
        // credit pool can't cover the next run). Anything else gets
        // clamped to [1, 10000].
        max_runs: Number(max_runs) === 0
          ? 0
          : Math.max(1, Math.min(10_000, Number(max_runs) || 10)),
        // runs_used + last_run_at preserved by the upsert below — only
        // the columns we explicitly set get overwritten.
        next_fire_at: nextFireAt,
        last_error: null,
        claimed_at: null,
        graph,
        updated_at: new Date().toISOString(),
      }

      // Upsert on (space_id, trigger_node_id). If the row exists we
      // refresh active=true + zero out the error/claim so a re-Start
      // after a manual Stop resumes cleanly.
      const inserted = await supaFetch(
        'scheduled_workflows?on_conflict=space_id,trigger_node_id',
        {
          method: 'POST',
          body: payload,
          prefer: 'resolution=merge-duplicates,return=representation',
        }
      )
      const row = Array.isArray(inserted) ? inserted[0] : inserted
      return res.status(200).json({
        ok: true,
        id: row?.id,
        next_fire_at: row?.next_fire_at,
      })
    }

    if (req.method === 'DELETE') {
      const space_id = req.query.space_id
      const trigger_node_id = req.query.trigger_node_id
      if (!space_id || !trigger_node_id) {
        return res.status(400).json({ error: 'space_id + trigger_node_id required' })
      }
      // RLS scopes deletion to the caller's own rows so no profile
      // check needed — they can only delete what they own.
      await supaFetch(
        `scheduled_workflows?space_id=eq.${encodeURIComponent(space_id)}` +
        `&trigger_node_id=eq.${encodeURIComponent(trigger_node_id)}` +
        `&user_id=eq.${auth.user.id}`,
        { method: 'DELETE', prefer: 'return=minimal' }
      )
      return res.status(200).json({ ok: true })
    }

    if (req.method === 'GET') {
      // Two modes:
      //   ?space_id=…           → schedules for that space (legacy)
      //   ?all=1                → every active schedule for this user
      //                            (used by the Spaces toolbar pill)
      const space_id = req.query.space_id
      const wantAll = req.query.all === '1' || req.query.all === 'true'
      if (!space_id && !wantAll) return res.status(400).json({ error: 'space_id or all=1 required' })
      const filter = space_id
        ? `space_id=eq.${encodeURIComponent(space_id)}&user_id=eq.${auth.user.id}`
        : `user_id=eq.${auth.user.id}&active=eq.true`
      const rows = await supaFetch(
        `scheduled_workflows?${filter}` +
        `&select=id,space_id,profile_id,trigger_node_id,active,interval_ms,max_runs,runs_used,next_fire_at,last_run_at,last_error` +
        `&order=next_fire_at.asc`
      ).catch(() => [])
      return res.status(200).json({ schedules: rows || [] })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('save-schedule error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
