// GET /api/_debug/upload-post-state?profile_id=...&token=...
//
// TEMPORARY read-only diagnostic. Returns the RAW Upload-Post
// scheduled-jobs list for a brand alongside the local content_scripts
// state, so we can see exactly why the delete cascade isn't finding
// matches.
//
// Gated on a per-request DEBUG_TOKEN env var (set on Vercel separately
// from any user-facing secret) so it's not callable by anyone who
// guesses the URL. Delete this file once the cascade bug is closed.
//
// Returns:
//   {
//     username:          <resolved Upload-Post username>,
//     upload_post_jobs:  [{ job_id, scheduled_date, title, ... }],
//     local_rows:        [{ id, title, scheduled_datetime, ... }],
//     orphan_candidates: [...]
//   }

import { setCors, supaFetch } from '../_lib/supabase.js'
import { resolveUploadpostUser, uploadpostListScheduled } from '../_lib/uploadpost.js'

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
    let rawList = null
    try {
      rawList = await uploadpostListScheduled(username)
    } catch (e) {
      rawList = { error: e?.message, status: e?.status }
    }

    const localRows = await supaFetch(
      `content_scripts?profile_id=eq.${profileId}&status=eq.scheduled&select=id,title,scheduled_datetime,uploadpost_request_id,uploadpost_job_id&order=scheduled_datetime.asc`
    ).catch(() => [])

    return res.status(200).json({
      profile_id: profileId,
      username,
      upload_post_jobs_raw: rawList,
      local_rows: localRows,
      now: new Date().toISOString(),
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
