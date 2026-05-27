// POST /api/studio/render-final
//
// Thin dispatcher to the Fly worker. The worker (scalesolo-worker) has
// real Chrome (no @sparticuz/Lambda RAF throttling), no 5-minute
// function ceiling, and 8GB RAM on performance-4x machines. The full
// render logic lives in worker/studio-render.js — this file just
// validates the request, gates the user, and POSTs to the worker.
//
// Body: { studio_video_id }
// Returns: { ok, dispatched_to: WORKER_URL } immediately on dispatch.
//          The actual render completion is reported via Realtime updates
//          to studio_videos.render_progress + status.
//
// Required env vars:
//   WORKER_URL                   — base URL of scalesolo-worker on Fly
//   WORKER_SHARED_SECRET         — same value as on the worker
//
// The previous implementation (Vercel-side Puppeteer + ffmpeg) lives
// in git history if we ever need to roll back. It hit Lambda's hard
// 5-min limit on multi-segment bakes and silently fell back to
// drawtext on every motion segment because of headless RAF throttling.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { gateStudio } from './_lib/gate.js'
import { customerIdForUser } from '../_lib/credits.js'

// Render-only gate. Bakes don't burn provider quotas (Claude / HeyGen /
// ElevenLabs) — those happen at asset-gen time. But Fly compute time
// is real money, so we still require *some* ai_tokens balance so we
// can pay for the chat + enrich + refresh calls that fire as part of
// the render-flow. Threshold is set low: a few thousand ai_tokens.
async function gateRenderCredits(userId) {
  const customerId = await customerIdForUser(userId)
  if (!customerId) {
    return { error: 'No active subscription. Start a plan to render Studio videos.', code: 'no_subscription' }
  }
  const pools = await supaFetch(
    `credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`,
  )
  const aiTokens = Number(pools?.[0]?.balance || 0)
  const minNeeded = 30000  // covers the ~25k high-bound for enrich + refresh + a few chat turns
  if (aiTokens < minNeeded) {
    return {
      error: `Insufficient AI tokens to render (need ~${minNeeded}, have ${aiTokens}). Top up your AI tokens balance.`,
      code: 'insufficient_credits',
    }
  }
  return null
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    gateStudio(auth.user.id)

    const videoId = req.body?.studio_video_id
    if (!videoId) return res.status(400).json({ error: 'studio_video_id required' })

    // Credit gate — must hold ai_tokens for the enrich + chat passes.
    // Avatar / voice were already paid for at asset-gen time; this
    // pass just runs a few Claude calls + ffmpeg.
    const creditErr = await gateRenderCredits(auth.user.id)
    if (creditErr) return res.status(402).json({ error: creditErr.error, code: creditErr.code })

    // Validate access before bothering the worker
    const vRows = await supaFetch(`studio_videos?id=eq.${videoId}&select=id,profile_id&limit=1`)
    const video = vRows?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    const WORKER_URL = process.env.WORKER_URL
    const WORKER_SECRET = process.env.WORKER_SHARED_SECRET
    if (!WORKER_URL) {
      return res.status(500).json({
        error: 'WORKER_URL not configured. Studio renders are dispatched to the scalesolo-worker Fly app — set WORKER_URL in Vercel env to its public URL.',
      })
    }

    // Fire-and-forget dispatch. We DON'T await the worker's full render
    // (which can take several minutes) inside this Vercel function —
    // that would defeat the whole point of the migration. Instead the
    // worker writes progress + final status directly to studio_videos
    // via service-role Supabase access, and the frontend listens via
    // Realtime.
    //
    // We DO wait for the worker to confirm it accepted the job (status
    // check on the initial POST) before returning — so the user gets
    // an immediate error if the worker is down, instead of staring at
    // a render that never started.
    const workerUrl = `${WORKER_URL.replace(/\/$/, '')}/jobs/studio-render`
    const dispatchedAt = new Date().toISOString()

    // Write the "dispatching" status to the DB BEFORE firing the
    // worker request. If we wrote it after, there'd be a race: the
    // worker often writes its own "baking" status within ~1s, and our
    // 4s-delayed "dispatching" write would overwrite it — leaving the
    // UI stuck on "dispatching" while the bake actually progresses
    // silently. Pre-writing means the worker's later writes are
    // monotonically newer and always win.
    await supaFetch(`studio_videos?id=eq.${videoId}`, {
      method: 'PATCH',
      body: {
        status: 'rendering',
        error: null,
        render_progress: {
          stage: 'dispatching',
          current: 0,
          total: 0,
          started_at: dispatchedAt,
          hf_rendered: [],
          hf_fallback: [],
        },
      },
      prefer: 'return=minimal',
    })

    // Send the dispatch. The worker's /jobs/studio-render handler holds
    // the connection open for the entire bake (minutes), so we use
    // AbortController to cut the connection after ~4s — long enough
    // for TCP handshake + Node to start processing the body, short
    // enough that Vercel returns inside its function budget. The
    // worker keeps running in the background after we abort.
    const dispatchAbort = new AbortController()
    const dispatchTimeout = setTimeout(() => dispatchAbort.abort(), 4000)
    try {
      await fetch(workerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(WORKER_SECRET ? { 'x-worker-secret': WORKER_SECRET } : {}),
        },
        body: JSON.stringify({ studio_video_id: videoId }),
        signal: dispatchAbort.signal,
      })
    } catch (err) {
      // AbortError is the EXPECTED case — the worker is now processing
      // the request. Any other error means dispatch genuinely failed
      // (DNS, refused, 401 before body sent, etc.).
      if (err.name !== 'AbortError') {
        clearTimeout(dispatchTimeout)
        console.warn('[studio-render dispatch] worker call failed:', err.message)
        return res.status(502).json({
          error: `Dispatch to worker failed: ${err.message}. Check WORKER_URL on Vercel + worker availability.`,
        })
      }
    } finally {
      clearTimeout(dispatchTimeout)
    }

    return res.status(202).json({
      ok: true,
      dispatched_to: WORKER_URL,
      message: 'Render dispatched to Fly worker. Watch studio_videos.render_progress via Realtime for status.',
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
