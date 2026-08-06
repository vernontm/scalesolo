// OPERATOR (authenticated). List / read Brand Intake submissions.
//
// GET /api/intake/submissions?profile_id=<uuid>
//   Newest-first list for a brand the caller owns, capped at 50 rows and
//   WITHOUT the answers blob, so a flooded table cannot turn the review
//   modal fetch into a multi-megabyte response.
//
// GET /api/intake/submissions?profile_id=<uuid>&id=<uuid>
//   Detail mode: one submission including its full answers. Used by the
//   Prefill flow right before mapping answers into the editor.
//
// Owner / admin only, mirroring api/profiles.js access checks. Reads via
// the service role after the ownership check (the table has RLS on and no
// anon policy, so this is the only read path).

import { setCors, requireUser, supaFetch, assertProfileAccess, isUuid } from '../_lib/supabase.js'

const LIST_LIMIT = 50

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return
  const userId = auth.user.id

  try {
    const profileId = req.query.profile_id
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })

    // Owner / admin only. assertProfileAccess also validates uuid shape.
    const role = await assertProfileAccess(userId, profileId)
    if (!['owner', 'admin'].includes(role)) return res.status(403).json({ error: 'Forbidden' })

    // Detail mode: one row, answers included.
    const submissionId = req.query.id
    if (submissionId) {
      if (!isUuid(submissionId)) return res.status(400).json({ error: 'Invalid id format' })
      const rows = await supaFetch(
        `brand_intake_submissions?profile_id=eq.${profileId}&id=eq.${submissionId}&select=id,answers,summary_md,status,created_at&limit=1`
      )
      const submission = rows?.[0]
      if (!submission) return res.status(404).json({ error: 'Submission not found' })
      return res.status(200).json({ submission })
    }

    // List mode: summaries only, newest first, hard limit.
    const rows = await supaFetch(
      `brand_intake_submissions?profile_id=eq.${profileId}&order=created_at.desc&select=id,summary_md,status,created_at&limit=${LIST_LIMIT}`
    )
    return res.status(200).json({ submissions: Array.isArray(rows) ? rows : [] })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
