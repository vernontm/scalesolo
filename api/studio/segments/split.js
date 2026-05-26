// POST /api/studio/segments/split
// Body: { segment_id, split_at }
//
// Splits a segment's script_text at character offset `split_at` into
// the parent (prefix) and a new segment inserted right after (suffix).
// Every asset URL + job id on both halves is cleared so the
// orchestrator regenerates voice / image / avatar from the new text.
//
// Calls the public.studio_split_segment(uuid, int) RPC. See
// supabase/migrations/0046_studio_split_segment.sql for the SQL
// contract — atomic, locks the parent, shifts downstream indexes up
// by 1 inside a single transaction.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../../_lib/supabase.js'
import { gateStudio } from '../_lib/gate.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    gateStudio(auth.user.id)
    const { segment_id, split_at } = req.body || {}
    if (!segment_id || typeof segment_id !== 'string') {
      return res.status(400).json({ error: 'segment_id required' })
    }
    const splitAt = Number(split_at)
    if (!Number.isFinite(splitAt) || splitAt < 0) {
      return res.status(400).json({ error: 'split_at must be a non-negative integer (cursor offset into script_text)' })
    }

    // Access check — load the segment, verify the caller owns the
    // parent brand profile. The RPC uses security invoker so RLS
    // would catch this too, but failing fast here gives a cleaner
    // 403 instead of a Postgres "0 rows" surprise.
    const segRows = await supaFetch(
      `studio_segments?id=eq.${encodeURIComponent(segment_id)}&select=id,profile_id,script_text&limit=1`,
    )
    const seg = segRows?.[0]
    if (!seg) return res.status(404).json({ error: 'Segment not found' })
    await assertProfileAccess(auth.user.id, seg.profile_id)

    // Guard a UX-level edge case before we even dispatch the RPC:
    // splitting at 0 or at the end of the script means one half is
    // empty, which the SQL function also rejects but with a less
    // friendly error. Surface a clean 400 here.
    const len = (seg.script_text || '').length
    if (splitAt <= 0 || splitAt >= len) {
      return res.status(400).json({
        error: 'Split point must be inside the sentence — not at the start or end.',
      })
    }

    // Call the RPC. supaFetch's path-based wrapper hits PostgREST,
    // which exposes Postgres functions under /rpc/<fn_name>. The
    // body shape is { <param_name>: value } using the function's
    // own parameter names (p_segment_id, p_split_at).
    const result = await supaFetch('rpc/studio_split_segment', {
      method: 'POST',
      body: { p_segment_id: segment_id, p_split_at: Math.floor(splitAt) },
    })
    const rows = Array.isArray(result) ? result : []
    if (rows.length !== 2) {
      return res.status(500).json({
        error: `studio_split_segment returned ${rows.length} rows (expected 2). Result: ${JSON.stringify(result).slice(0, 200)}`,
      })
    }
    return res.status(200).json({ ok: true, segments: rows })
  } catch (err) {
    // Surface the Postgres error text (e.g. "Split point would
    // produce an empty segment") so the UI can show the user what
    // went wrong instead of a generic 500.
    return res.status(err.status || 500).json({ error: err.message || String(err) })
  }
}
