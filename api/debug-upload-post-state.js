// GET /api/debug-upload-post-state?profile_id=...&token=...
//
// TEMPORARY read-only diagnostic. Hits multiple Upload-Post listing
// endpoints with the same auth and reports what each one returns so
// we can see exactly which (if any) surfaces the brand's scheduled
// jobs.

import { setCors, supaFetch } from './_lib/supabase.js'
import { resolveUploadpostUser, uploadpost } from './_lib/uploadpost.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const expected = process.env.DEBUG_TOKEN || ''
  const supplied = (req.query.token || '').toString()
  if (!expected || !supplied || expected !== supplied) {
    return res.status(404).json({ error: 'Not found' })
  }

  const profileId = req.query.profile_id
  if (!profileId) return res.status(400).json({ error: 'profile_id required' })

  try {
    const username = await resolveUploadpostUser(profileId)
    const probe = async (path) => {
      try {
        const data = await uploadpost(path)
        return { ok: true, path, sample: data }
      } catch (e) {
        return { ok: false, path, status: e?.status || null, error: e?.message || String(e) }
      }
    }

    const u = encodeURIComponent(username)
    // Try every URL pattern Upload-Post has historically used. Some
    // of these are guesses — that's the point of the probe.
    const probes = await Promise.all([
      probe(`/api/uploadposts/schedule`),
      probe(`/api/uploadposts/scheduled`),
      probe(`/api/uploadposts/posts/${u}?status=scheduled&limit=200`),
      probe(`/api/uploadposts/posts/${u}?status=pending&limit=200`),
      probe(`/api/uploadposts/posts/${u}?limit=200`),
      probe(`/api/uploadposts/users/${u}/scheduled`),
      probe(`/api/uploadposts/users/${u}/posts?status=scheduled`),
    ])

    const localRows = await supaFetch(
      `content_scripts?profile_id=eq.${profileId}&status=eq.scheduled&select=id,title,scheduled_datetime,uploadpost_request_id,uploadpost_job_id&order=scheduled_datetime.asc`
    ).catch(() => [])

    return res.status(200).json({
      profile_id: profileId,
      username,
      probes,
      local_rows: localRows,
      now: new Date().toISOString(),
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
