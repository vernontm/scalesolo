// POST /api/carousels/generate
// Body: { profile_id, topic, slide_count?, reference_urls?, theme?, extra_style?, outfit?, format?, signature?, aspect? }
// Returns: { job_id } immediately.
//
// Generation runs as a BACKGROUND JOB (a resumable step machine), so the
// request returns instantly and the multi-minute image pipeline can run
// server-side without ever hitting the serverless time limit no matter the
// slide count. The builder polls GET /api/carousels/status?job_id=... and the
// job is driven by an immediate self-kick to /api/carousels/process plus an
// every-minute cron safety net.

import { waitUntil } from '@vercel/functions'
import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { kickCarouselJob } from '../_lib/carousel-kick.js'

export const config = { maxDuration: 30 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, topic, slide_count = 6, reference_urls, theme, extra_style, outfit, format, signature, aspect = '3:4' } = req.body || {}
    if (!profile_id || !topic) return res.status(400).json({ error: 'profile_id + topic required' })
    await assertProfileAccess(auth.user.id, profile_id)

    const request = {
      topic: String(topic), slide_count, reference_urls, theme, extra_style, outfit, format, signature, aspect,
    }
    const inserted = await supaFetch('carousel_jobs', {
      method: 'POST', prefer: 'return=representation',
      body: { user_id: auth.user.id, profile_id, status: 'queued', step: 'plan', stage: 'Getting started', request },
    })
    const job = Array.isArray(inserted) ? inserted[0] : inserted
    if (!job?.id) return res.status(500).json({ error: 'Could not create the generation job' })

    // Fire the immediate kick in the background so this request returns at
    // once; the every-minute cron picks the job up regardless.
    waitUntil(kickCarouselJob(job.id, auth.user.id))

    return res.status(202).json({ job_id: job.id, status: 'queued' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
