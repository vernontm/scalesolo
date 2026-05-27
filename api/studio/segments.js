// /api/studio/segments — CRUD for individual rows in the Studio video map.
//
//   GET    ?studio_video_id=…       — list all segments for a video, ordered
//   POST                            — create a single segment (chat "insert row")
//   PATCH  ?id=…                    — update editable fields on one segment
//   DELETE ?id=…                    — delete one segment
//
// Bulk create (used by the Claude segmentation pass after it generates
// the initial video map) lives in /api/studio/generate-map.js, not here.
//
// Every method goes through gateStudio() first.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { gateStudio } from './_lib/gate.js'

const ALLOWED_CREATE = new Set([
  'studio_video_id', 'profile_id', 'segment_index', 'segment_type',
  'script_text', 'image_prompt', 'motion_gesture_prompt', 'broll_video_prompt',
  'hyperframes_composition_id', 'hyperframes_variables',
  'transition_in', 'sound_effect', 'is_video_broll',
])
const ALLOWED_PATCH = new Set([
  // User-editable from the video map UI
  'script_text', 'segment_type', 'approved',
  'image_prompt', 'motion_gesture_prompt', 'broll_video_prompt',
  'hyperframes_composition_id', 'hyperframes_variables',
  'transition_in', 'sound_effect', 'is_video_broll',
  // Server-set during asset orchestration
  'voice_url', 'voice_duration_secs', 'avatar_video_url', 'image_url',
  'broll_video_url', 'grok_task_id',
  'status', 'error', 'rendered_chunk_url',
])

// Helper: resolve a segment's profile_id (used for access check) without
// pulling the whole row twice. Falls back to the parent video if denorm
// is missing for any reason (legacy rows, etc.).
async function loadSegmentForAccess(id) {
  const rows = await supaFetch(`studio_segments?id=eq.${id}&select=id,profile_id,studio_video_id&limit=1`)
  return rows?.[0] || null
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    gateStudio(auth.user.id)

    if (req.method === 'GET') {
      const { studio_video_id: videoId } = req.query
      if (!videoId) return res.status(400).json({ error: 'studio_video_id required' })
      // Verify access via parent video's profile_id
      const v = await supaFetch(`studio_videos?id=eq.${videoId}&select=profile_id&limit=1`)
      if (!v?.[0]) return res.status(404).json({ error: 'Video not found' })
      await assertProfileAccess(auth.user.id, v[0].profile_id)

      const list = await supaFetch(
        `studio_segments?studio_video_id=eq.${videoId}&select=*&order=segment_index.asc&limit=500`
      )
      return res.status(200).json({ segments: list || [] })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.studio_video_id) return res.status(400).json({ error: 'studio_video_id required' })
      if (!body.segment_type) return res.status(400).json({ error: 'segment_type required' })
      if (body.segment_index == null) return res.status(400).json({ error: 'segment_index required' })

      // Look up the parent video to derive profile_id (so the client
      // doesn't have to pass it explicitly, and so we can verify
      // access in one place).
      const v = await supaFetch(`studio_videos?id=eq.${body.studio_video_id}&select=profile_id&limit=1`)
      if (!v?.[0]) return res.status(404).json({ error: 'Video not found' })
      await assertProfileAccess(auth.user.id, v[0].profile_id)

      const insertRow = { profile_id: v[0].profile_id, status: 'pending', overlay_placements: [] }
      for (const [k, v2] of Object.entries(body)) {
        if (ALLOWED_CREATE.has(k) && v2 !== undefined) insertRow[k] = v2
      }
      const created = await supaFetch('studio_segments', { method: 'POST', body: insertRow })
      const segment = Array.isArray(created) ? created[0] : created
      return res.status(201).json({ segment })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id || (req.body && req.body.id)
      if (!id) return res.status(400).json({ error: 'id required' })
      const existing = await loadSegmentForAccess(id)
      if (!existing) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, existing.profile_id)

      const updates = {}
      for (const [k, v] of Object.entries(req.body || {})) {
        if (k === 'id') continue
        if (ALLOWED_PATCH.has(k)) updates[k] = v
      }
      if (!Object.keys(updates).length) return res.status(400).json({ error: 'no editable fields in body' })

      // Any user-driven edit invalidates the cached chunk. The worker
      // would otherwise reuse an out-of-date chunk on the next bake
      // and the edit would silently fail to appear. Skip invalidation
      // when the caller is specifically setting rendered_chunk_url
      // (which is how the worker itself reports completion).
      if (!('rendered_chunk_url' in updates)) {
        updates.rendered_chunk_url = null
      }

      const updated = await supaFetch(`studio_segments?id=eq.${id}`, {
        method: 'PATCH', body: updates,
      })
      const segment = Array.isArray(updated) ? updated[0] : updated
      return res.status(200).json({ segment })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const existing = await loadSegmentForAccess(id)
      if (!existing) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, existing.profile_id)
      await supaFetch(`studio_segments?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
