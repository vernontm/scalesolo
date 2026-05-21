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
import { customerIdForUser } from '../_lib/credits.js'

export const config = { maxDuration: 60 }

// Mirrors NODE_COST_HINT in src/lib/space-nodes.jsx. Duplicated here so
// the cron doesn't have to import the giant client bundle. Kept in sync
// manually — if NODE_COST_HINT changes, update both spots.
const NODE_COST_HINT = {
  text_input: 0, manual_caption: 0, image_upload: 0, brand_profile: 200,
  auto_run: 0, script_gen: 3000, caption_gen: 2500, text_post_gen: 2000,
  image_gen: 4000, avatar_picker: 0, voice_gen: 2000, url_reference: 0,
  collection: 0, combine_videos: 1500, combine_av: 400, video_polish: 1500,
  captions: 2000, schedule_post: 100, save_library: 0,
  // avatar_render is metered in VIDEO UNITS, not AI tokens — handled below.
}

// Each avatar_render node = ~5 video credits per 30-second clip. Multi-
// clip / cycle-looks runs can spend more, but 5 is the conservative
// pre-flight estimate that matches the body's surface UI.
const AVATAR_RENDER_VIDEO_UNITS = 5

// Compute the estimated cost of a single workflow run from its graph.
// Returns { ai_tokens, video_units } — both are minimums (the run may
// cost more if e.g. voice_gen spans a long script). Used purely to
// decide "can the next run even start?".
function estimateRunCost(graph) {
  let aiTokens = 0
  let videoUnits = 0
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  for (const node of nodes) {
    const t = node?.data?.kind || node?.type
    if (!t) continue
    if (t === 'avatar_render') {
      videoUnits += AVATAR_RENDER_VIDEO_UNITS
      continue
    }
    const cost = NODE_COST_HINT[t]
    if (Number.isFinite(cost)) aiTokens += cost
  }
  return { ai_tokens: aiTokens, video_units: videoUnits }
}

// Pull current pool balances for a user. Returns null if the user has no
// customer record yet — caller should treat that as "no budget".
async function fetchPoolBalances(userId) {
  try {
    const customerId = await customerIdForUser(userId)
    if (!customerId) return null
    const rows = await supaFetch(
      `credit_pools?customer_id=eq.${customerId}&select=pool_type,balance`
    )
    const byPool = { ai_tokens: 0, video_units: 0, voice_minutes: 0 }
    for (const r of rows || []) byPool[r.pool_type] = Number(r.balance)
    return byPool
  } catch {
    return null
  }
}

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

  // Zombie space_runs sweep. ONLY targets browser-side runs, which
  // depend on the user's tab staying open to finalize. Server-side
  // runs (triggered_by manual_server / server_cron) execute on the
  // Fly worker, which writes finished_at itself when done — even a
  // 30-minute multi-clip render is legit, not a zombie. Sweeping
  // those was killing in-progress runs mid-execution and reporting
  // them to the user as failed.
  //
  // Sweep cap raised to 60 min to give browser-side runs more rope
  // too — a 5-clip polish + ZapCap can flirt with 15 min under load.
  try {
    const sweepCutoff = new Date(Date.now() - 60 * 60_000).toISOString()
    const swept = await supaFetch(
      `space_runs?status=eq.running&started_at=lt.${encodeURIComponent(sweepCutoff)}` +
      `&triggered_by=in.(per_node,auto_run,manual)` +
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
            errors: [{ msg: 'Run did not finalize within 60 minutes (likely the browser tab was closed mid-run). The auto-cleanup marked it failed.' }],
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
      const isUnlimited = Number(row.max_runs) === 0

      // Cap hit while waiting in the queue? Mark inactive and skip.
      // Unlimited rows (max_runs = 0) skip this check entirely — they
      // stop via the budget gate below instead.
      if (!isUnlimited && Number(row.runs_used) >= Number(row.max_runs)) {
        await supaFetch(`scheduled_workflows?id=eq.${row.id}`, {
          method: 'PATCH',
          body: { active: false, updated_at: new Date().toISOString() },
          prefer: 'return=minimal',
        }).catch(() => {})
        continue
      }

      // In-progress check: the worker writes space_runs rows with
      // status=running while a workflow is executing. If one is still
      // running for THIS trigger, skip this tick so we don't fire a
      // second run on top of an in-progress one. The "10 second pause
      // between completed runs" semantic is enforced here: even if
      // next_fire_at is overdue, we wait for the previous run to
      // finish before dispatching the next one.
      try {
        const inProgress = await supaFetch(
          `space_runs?space_id=eq.${encodeURIComponent(row.space_id)}` +
          `&triggered_by=eq.auto_run&status=eq.running&select=id&limit=1`
        ).catch(() => [])
        if (inProgress?.length) {
          stats.skipped_claimed += 1
          continue
        }
      } catch { /* fall through — better to attempt than to silently stall */ }

      // Budget pre-flight: estimate the cost of one run from the
      // graph and refuse to fire if either pool can't cover it.
      // Unlimited mode REQUIRES this check (it's how the "stop when
      // credits run out" semantics work); bounded mode also runs it
      // so users don't burn a slot on a guaranteed-to-fail run.
      try {
        const cost = estimateRunCost(row.graph)
        const pools = await fetchPoolBalances(row.user_id)
        const aiOk = !pools ? false : pools.ai_tokens >= cost.ai_tokens
        const videoOk = !pools ? false : pools.video_units >= cost.video_units
        if (!aiOk || !videoOk) {
          // Out of budget — deactivate. Surface the reason on
          // last_error so the canvas can show it.
          const reason = !pools
            ? 'Stopped: no customer / credit record'
            : !aiOk && !videoOk
              ? `Stopped: needs ${cost.ai_tokens.toLocaleString()} AI tokens + ${cost.video_units} video credits, have ${pools.ai_tokens.toLocaleString()} + ${pools.video_units}`
              : !aiOk
                ? `Stopped: needs ${cost.ai_tokens.toLocaleString()} AI tokens, have ${pools.ai_tokens.toLocaleString()}`
                : `Stopped: needs ${cost.video_units} video credits, have ${pools.video_units}`
          await supaFetch(`scheduled_workflows?id=eq.${row.id}`, {
            method: 'PATCH',
            body: {
              active: false,
              last_error: reason,
              updated_at: new Date().toISOString(),
            },
            prefer: 'return=minimal',
          }).catch(() => {})
          continue
        }
      } catch (e) {
        // Pre-flight is best-effort. If we can't compute, fall
        // through and let the worker's own per-node credit checks
        // catch insufficiency. Log for debugging.
        console.warn(`[cron] budget pre-flight failed for schedule ${row.id}:`, e?.message)
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

        // Tick succeeded (worker accepted). Bump runs_used and set
        // next_fire_at = NOW + 10s. The in-progress check above
        // gates the actual dispatch on the previous run finishing,
        // so even though next_fire_at fires every minute, only one
        // run will be in flight per trigger at a time. The 10s
        // setting is preserved as the floor — once the worker
        // completes, the next cron tick (within 60s) fires the
        // next run.
        const nextFireAt = new Date(Date.now() + 10_000).toISOString()
        const newRunsUsed = Number(row.runs_used) + 1
        const reachedCap = !isUnlimited && newRunsUsed >= Number(row.max_runs)
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
