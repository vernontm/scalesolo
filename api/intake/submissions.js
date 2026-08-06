// OPERATOR (authenticated). List / read / status-update Brand Intake
// submissions.
//
// GET /api/intake/submissions?profile_id=<uuid>[&include_archived=1]
//   Newest-first list for a brand the caller owns, capped at 50 rows.
//   Archived rows are excluded unless include_archived=1. Each row's
//   summary_md is compiled server-side from the stored answers AT READ TIME
//   (compileIntakeSummary); the stored summary_md column is deliberately
//   ignored on every read path, so rows written before the server-side
//   compile shipped can never show a client-controlled digest. The raw
//   answers blob is NOT included, keeping a flooded table from turning the
//   review modal fetch into a multi-megabyte response.
//
// GET /api/intake/submissions?profile_id=<uuid>&id=<uuid>
//   Detail mode: one submission including its full answers, plus the same
//   read-time compiled summary. Used by the Prefill flow right before
//   mapping answers into the editor.
//
// PATCH /api/intake/submissions   body: { profile_id, id, status }
//   Move one submission to 'reviewed' or 'archived' (the only statuses an
//   operator may set; new rows are always inserted 'pending' by
//   api/intake.js). This is the release valve for the per-brand pending cap
//   in api/intake.js: reviewing or archiving rows frees the intake link for
//   new submissions.
//
// Owner / admin only, mirroring api/profiles.js access checks. All access
// goes via the service role after the ownership check (the table has RLS on
// and no policies, so this is the only read/update path).

import { setCors, requireUser, supaFetch, assertProfileAccess, isUuid } from '../_lib/supabase.js'
import { compileIntakeSummary } from '../_lib/brandIntake.js'

const LIST_LIMIT = 50
const OPERATOR_STATUSES = new Set(['reviewed', 'archived'])

// Compile a row's display summary from its stored answers. Wrapped so one
// corrupt legacy row degrades to a placeholder instead of failing the whole
// list request. compileIntakeSummary itself normalizes hostile shapes, so
// this catch is a belt-and-suspenders guard.
function compiledSummaryOf(row) {
  try {
    return compileIntakeSummary(row?.answers)
  } catch {
    return '(unreadable submission)'
  }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (!['GET', 'PATCH'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const auth = await requireUser(req, res)
  if (!auth) return
  const userId = auth.user.id

  try {
    if (req.method === 'PATCH') {
      const { profile_id: profileId, id, status } = req.body || {}
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      if (!isUuid(id)) return res.status(400).json({ error: 'Invalid id format' })
      if (!OPERATOR_STATUSES.has(status)) {
        return res.status(400).json({ error: 'status must be reviewed or archived' })
      }

      // Owner / admin only. assertProfileAccess also validates uuid shape.
      const role = await assertProfileAccess(userId, profileId)
      if (!['owner', 'admin'].includes(role)) return res.status(403).json({ error: 'Forbidden' })

      const updated = await supaFetch(
        `brand_intake_submissions?profile_id=eq.${profileId}&id=eq.${id}&select=id,status`,
        { method: 'PATCH', body: { status } }
      )
      const row = Array.isArray(updated) ? updated[0] : null
      if (!row) return res.status(404).json({ error: 'Submission not found' })
      return res.status(200).json({ submission: { id: row.id, status: row.status } })
    }

    const profileId = req.query.profile_id
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })

    // Owner / admin only. assertProfileAccess also validates uuid shape.
    const role = await assertProfileAccess(userId, profileId)
    if (!['owner', 'admin'].includes(role)) return res.status(403).json({ error: 'Forbidden' })

    // Detail mode: one row, answers included, summary compiled at read time.
    const submissionId = req.query.id
    if (submissionId) {
      if (!isUuid(submissionId)) return res.status(400).json({ error: 'Invalid id format' })
      const rows = await supaFetch(
        `brand_intake_submissions?profile_id=eq.${profileId}&id=eq.${submissionId}&select=id,answers,status,created_at&limit=1`
      )
      const sub = rows?.[0]
      if (!sub) return res.status(404).json({ error: 'Submission not found' })
      return res.status(200).json({
        submission: {
          id: sub.id,
          answers: sub.answers,
          summary_md: compiledSummaryOf(sub),
          status: sub.status,
          created_at: sub.created_at,
        },
      })
    }

    // List mode: newest first, hard limit, archived hidden by default. The
    // answers are selected only to compile the summary server-side; they are
    // stripped from the response below.
    const statusFilter = req.query.include_archived ? '' : '&status=neq.archived'
    const rows = await supaFetch(
      `brand_intake_submissions?profile_id=eq.${profileId}${statusFilter}&order=created_at.desc&select=id,answers,status,created_at&limit=${LIST_LIMIT}`
    )
    const submissions = (Array.isArray(rows) ? rows : []).map((row) => ({
      id: row.id,
      summary_md: compiledSummaryOf(row),
      status: row.status,
      created_at: row.created_at,
    }))
    return res.status(200).json({ submissions })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
