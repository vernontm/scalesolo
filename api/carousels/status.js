// GET /api/carousels/status?job_id=...
// Returns the carousel job's progress for the builder to poll.

import { setCors, requireUser, supaFetch } from '../_lib/supabase.js'

export const config = { maxDuration: 10 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  const jobId = req.query?.job_id
  if (!jobId) return res.status(400).json({ error: 'job_id required' })

  const rows = await supaFetch(`carousel_jobs?id=eq.${jobId}&limit=1&select=id,user_id,status,step,stage,progress,images,content_id,title,caption,hashtags,error`)
  const job = Array.isArray(rows) ? rows[0] : null
  if (!job) return res.status(404).json({ error: 'job not found' })
  if (String(job.user_id) !== String(auth.user.id)) return res.status(403).json({ error: 'Forbidden' })

  return res.status(200).json({
    status: job.status,
    step: job.step,
    stage: job.stage,
    progress: job.progress || 0,
    images: Array.isArray(job.images) ? job.images : [],
    content_id: job.content_id || null,
    title: job.title || null,
    caption: job.caption || null,
    hashtags: job.hashtags || null,
    error: job.error || null,
  })
}
