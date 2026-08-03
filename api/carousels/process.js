// POST /api/carousels/process  { job_id }   (internal, secret-guarded)
//
// Advances one carousel job through as many steps as fit in the time budget,
// then either finishes or self-kicks for the remainder. Acknowledges the
// caller immediately and does the work in waitUntil so the kick returns fast.
// Idempotent + claim-locked so the cron and the self-kick never collide.

import { waitUntil } from '@vercel/functions'
import { setCors, requireUser, supaFetch } from '../_lib/supabase.js'
import { runStep } from '../_lib/carousel-engine.js'
import { kickCarouselJob } from '../_lib/carousel-kick.js'

export const config = { maxDuration: 300, memory: 2048, includeFiles: 'api/_fonts/**' }

const STEP_BUDGET_MS = 230_000
const STALE_MS = 4 * 60_000

async function loadJob(id) {
  const rows = await supaFetch(`carousel_jobs?id=eq.${id}&limit=1`)
  return Array.isArray(rows) ? rows[0] : null
}

async function patchJob(id, patch) {
  const body = { ...patch, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  await supaFetch(`carousel_jobs?id=eq.${id}`, { method: 'PATCH', body })
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return
  if (!auth.internal) return res.status(403).json({ error: 'Forbidden' })

  const jobId = req.body?.job_id
  if (!jobId) return res.status(400).json({ error: 'job_id required' })

  const job = await loadJob(jobId)
  if (!job) return res.status(404).json({ error: 'job not found' })
  if (String(job.user_id) !== String(auth.user.id)) return res.status(403).json({ error: 'Forbidden' })
  if (job.status === 'done' || job.status === 'failed') return res.status(200).json({ status: job.status })

  // Claim the job so a concurrent cron tick / kick doesn't double-run it.
  const staleIso = new Date(Date.now() - STALE_MS).toISOString()
  const claimed = await supaFetch(
    `carousel_jobs?id=eq.${jobId}&or=(claimed_at.is.null,claimed_at.lt.${staleIso})`,
    { method: 'PATCH', prefer: 'return=representation', body: { status: 'working', claimed_at: new Date().toISOString(), attempts: (job.attempts || 0) + 1 } },
  )
  if (!Array.isArray(claimed) || !claimed.length) {
    return res.status(202).json({ status: 'already-working' })
  }

  // Acknowledge immediately; run the steps in the background.
  res.status(202).json({ status: 'working' })

  waitUntil((async () => {
    let cur = claimed[0]
    const t0 = Date.now()
    try {
      while (cur.status === 'working' && cur.step !== 'done') {
        const patch = await runStep(req, cur)
        await patchJob(jobId, patch)
        cur = { ...cur, ...patch }
        if (cur.status === 'done' || cur.status === 'failed' || cur.step === 'done') break
        if (Date.now() - t0 > STEP_BUDGET_MS) {
          // Out of budget for this invocation — hand off and stop.
          await kickCarouselJob(jobId, job.user_id)
          return
        }
      }
    } catch (e) {
      const insufficient = e?.code === 'insufficient_credits'
      await patchJob(jobId, {
        status: 'failed', step: cur.step, stage: 'Failed',
        error: insufficient ? `Not enough credits: ${e.message}` : (e?.message || 'Generation failed'),
      })
    }
  })())
}
