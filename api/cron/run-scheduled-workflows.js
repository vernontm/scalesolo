// Vercel cron — fires every minute, dispatches due workflows to Fly.
//
// Looks at every active, unclaimed scheduled_workflows row whose
// next_fire_at has passed. For each row:
//   1. Locks it with claimed_at = now (so a slow handler can't be
//      double-fired by the next cron tick).
//   2. POSTs the graph to the Fly worker /jobs/run-workflow with an
//      internal secret + impersonation header.
//   3. Worker runs the graph through its node-by-node executor, hits
//      Vercel APIs (script_gen, polish, schedule_post, etc.) as the
//      impersonated user.
//   4. On reply: bump runs_used, set next_fire_at = now + interval,
//      clear claimed_at + last_error. If max_runs hit, flip active=false.
//
// Fly call is fire-and-poll (the worker stashes a job_id and runs in
// the background); we lock the cron row immediately and the worker's
// done callback marks it complete. Worker timeouts are bounded by the
// worker itself — Vercel's 300s ceiling never matters since cron
// only kicks the request, doesn't wait for the full workflow run.
//
// Scheduled via vercel.json: "schedule": "* * * * *" (every minute).

import { setCors, supaFetch } from '../_lib/supabase.js'

export const config = { maxDuration: 60 }

const WORKER_URL = process.env.WORKER_URL
const WORKER_SECRET = process.env.WORKER_SHARED_SECRET
const INTERNAL_SECRET = process.env.WORKFLOW_INTERNAL_SECRET

// Cron auth: Vercel pings cron endpoints with a bearer token matching
// CRON_SECRET (set automatically when you configure crons in
// vercel.json). Reject anything without it so /api/cron/* isn't a
// public DoS target.
function isCronAuthed(req) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  return !!process.env.CRON_SECRET && bearer === process.env.CRON_SECRET
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }
  if (!isCronAuthed(req)) {
    return res.status(401).json({ error: 'Cron auth required' })
  }
  if (!WORKER_URL) {
    return res.status(500).json({ error: 'WORKER_URL not configured — workflow worker unreachable' })
  }
  if (!INTERNAL_SECRET) {
    return res.status(500).json({ error: 'WORKFLOW_INTERNAL_SECRET not configured' })
  }

  const startedAt = Date.now()
  const stats = { scanned: 0, dispatched: 0, errors: 0, skipped_claimed: 0, swept_zombie_runs: 0 }

  // Zombie space_runs sweep. Browser-side runs write a row at
  // start and update it on finish. If the user closes the tab
  // mid-run, the row never reaches finished_at and shows up in
  // the canvas Run history as "running" forever. Cap at 15 min
  // since the slowest legitimate workflow (5-clip polish + ZapCap)
  // tops out around 7-8 min. Anything past 15 is dead.
  try {
    const sweepCutoff = new Date(Date.now() - 15 * 60_000).toISOString()
    const swept = await supaFetch(
      `space_runs?status=eq.running&started_at=lt.${encodeURIComponent(sweepCutoff)}` +
      `&select=id&limit=100`
    ).catch(() => [])
    if (swept?.length) {
      const ids = swept.map((r) => r.id)
      await supaFetch(
        `space_runs?id=in.(${ids.map((i) => encodeURIComponent(i)).join(',')})`,
        {
          method: 'PATCH',
          body: {
            status: 'failed',
            finished_at: new Date().toISOString(),
            errors: [{ msg: 'Browser tab closed before run completed (auto-cleanup)' }],
          },
          prefer: 'return=minimal',
        }
      ).catch((e) => console.warn('[cron] zombie sweep PATCH failed:', e?.message))
      stats.swept_zombie_runs = ids.length
    }
  } catch (e) {
    console.warn('[cron] zombie sweep error:', e?.message)
  }

  try {
    // Pull every due, active, unclaimed schedule. claimed_at filter
    // doubles as a soft lock: rows mid-execution have claimed_at set,
    // so a cron tick that overlaps with a slow worker run skips them.
    const nowIso = new Date().toISOString()
    const due = await supaFetch(
      `scheduled_workflows?active=eq.true&claimed_at=is.null` +
      `&next_fire_at=lte.${encodeURIComponent(nowIso)}` +
      `&select=id,user_id,profile_id,space_id,trigger_node_id,interval_ms,max_runs,runs_used,graph&limit=50`
    ).catch(() => [])

    stats.scanned = due?.length || 0

    // Dispatch each one. We do these sequentially so a single tick
    // doesn't fan out 50 concurrent worker requests — the worker has
    // its own concurrency limit and we want fair scheduling.
    for (const row of due || []) {
      // Cap hit while waiting in the queue? Mark inactive and skip.
      if (Number(row.runs_used) >= Number(row.max_runs)) {
        await supaFetch(`scheduled_workflows?id=eq.${row.id}`, {
          method: 'PATCH',
          body: { active: false, updated_at: new Date().toISOString() },
          prefer: 'return=minimal',
        }).catch(() => {})
        continue
      }

      // Claim the row. If two cron instances overlap (Vercel's
      // scheduler can sometimes double-fire on the boundary), the
      // second one filters this out on the next pass thanks to
      // claimed_at IS NOT NULL.
      const claimedAt = new Date().toISOString()
      try {
        await supaFetch(`scheduled_workflows?id=eq.${row.id}&claimed_at=is.null`, {
          method: 'PATCH',
          body: { claimed_at: claimedAt, updated_at: claimedAt },
          prefer: 'return=minimal',
        })
      } catch (e) {
        // Couldn't claim — another tick beat us to it. Skip.
        stats.skipped_claimed += 1
        continue
      }

      // Dispatch to Fly worker. Fire-and-forget intent but we still
      // await the submit so we can update runs_used / next_fire_at
      // / last_error in one place. The worker returns 202 quickly
      // (background job pattern); long-running work continues there.
      try {
        const wRes = await fetch(`${WORKER_URL.replace(/\/$/, '')}/jobs/run-workflow`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(WORKER_SECRET ? { 'x-worker-secret': WORKER_SECRET } : {}),
          },
          body: JSON.stringify({
            schedule_id: row.id,
            user_id: row.user_id,
            profile_id: row.profile_id,
            space_id: row.space_id,
            trigger_node_id: row.trigger_node_id,
            graph: row.graph,
            internal_secret: INTERNAL_SECRET,
          }),
        })
        const wBody = await wRes.json().catch(() => ({}))
        if (!wRes.ok) throw new Error(wBody?.error || `Worker ${wRes.status}`)

        // Tick succeeded (worker accepted). Bump runs_used, advance
        // next_fire_at, clear lock + last error. Worker's own
        // success/failure callback will overwrite last_error later
        // if the actual workflow run errors.
        const nextFireAt = new Date(Date.now() + Number(row.interval_ms)).toISOString()
        const newRunsUsed = Number(row.runs_used) + 1
        const reachedCap = newRunsUsed >= Number(row.max_runs)
        await supaFetch(`scheduled_workflows?id=eq.${row.id}`, {
          method: 'PATCH',
          body: {
            runs_used: newRunsUsed,
            last_run_at: new Date().toISOString(),
            next_fire_at: nextFireAt,
            claimed_at: null,
            last_error: null,
            active: !reachedCap,
            updated_at: new Date().toISOString(),
          },
          prefer: 'return=minimal',
        })
        stats.dispatched += 1
      } catch (e) {
        // Dispatch failed. Release the lock + record the error so
        // the next tick retries. Don't bump runs_used on dispatch
        // errors — that'd burn a slot for free.
        await supaFetch(`scheduled_workflows?id=eq.${row.id}`, {
          method: 'PATCH',
          body: {
            claimed_at: null,
            last_error: String(e?.message || e).slice(0, 500),
            updated_at: new Date().toISOString(),
          },
          prefer: 'return=minimal',
        }).catch(() => {})
        console.error(`[cron] dispatch failed for schedule ${row.id}:`, e?.message)
        stats.errors += 1
      }
    }

    const duration_ms = Date.now() - startedAt
    return res.status(200).json({ ok: true, ...stats, duration_ms })
  } catch (err) {
    console.error('[cron] run-scheduled-workflows error:', err?.stack || err)
    return res.status(500).json({ error: err.message, ...stats })
  }
}
