// GET /api/videos/polish-status?job_id=...
//
// Proxies a single status fetch to the Fly worker's /jobs/:id endpoint.
// Used by the canvas to keep polling polish jobs that didn't complete
// inside the initial Vercel 300s window (typically 4K HEVC clips that
// need 3-5 min to composite).
//
// The canvas calls this every ~5-10s after receiving a 202 from
// /api/videos/polish until it sees status='done' (with result) or
// status='failed' (with error). Each call is a 1-2s round trip —
// nowhere near Vercel's timeout, so we can keep polling indefinitely.
//
// Auth: standard requireUser. The worker is gated by
// WORKER_SHARED_SECRET, but we don't expose that — this endpoint is
// the brokered way for canvas → worker status reads.

import { setCors, requireUser } from '../_lib/supabase.js'

export const config = { maxDuration: 30 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  const jobId = String(req.query.job_id || '').trim()
  if (!jobId) return res.status(400).json({ error: 'job_id required' })

  const WORKER_URL = process.env.WORKER_URL
  const WORKER_SECRET = process.env.WORKER_SHARED_SECRET
  if (!WORKER_URL) return res.status(500).json({ error: 'WORKER_URL not configured on this deployment' })

  try {
    const r = await fetch(
      `${WORKER_URL.replace(/\/$/, '')}/jobs/${encodeURIComponent(jobId)}`,
      { headers: WORKER_SECRET ? { 'x-worker-secret': WORKER_SECRET } : {} }
    )
    const body = await r.json().catch(() => ({}))
    if (!r.ok) {
      // 404 from worker = job expired or never existed. Canvas should
      // treat as terminal failure and offer to retry. Other statuses
      // pass through.
      return res.status(r.status).json(body)
    }
    return res.status(200).json(body)
  } catch (err) {
    return res.status(502).json({ error: `Worker unreachable: ${err.message}` })
  }
}
