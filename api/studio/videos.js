// /api/studio/videos — CRUD for Studio long-form video projects.
//
//   GET    ?profile_id=…            — list videos under a profile
//   GET    ?id=…                    — fetch one video (with segments inlined)
//   POST                            — create a new draft from the "new video" form
//   PATCH  ?id=…                    — update editable fields (title, status, etc.)
//   DELETE ?id=…                    — delete (cascade clears studio_segments)
//
// Every method goes through gateStudio() first. Non-allowlisted users
// get a 404 so the route appears not to exist.
//
// Profile access is verified via assertProfileAccess() so the user
// can't reach into another user's brand without being on the
// profile_access table for it.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { gateStudio } from './_lib/gate.js'

// Columns the client is allowed to write on create. Mirrors the form
// shape; anything outside this set is silently dropped.
const ALLOWED_CREATE = new Set([
  'profile_id', 'title', 'topic_prompt', 'reference_url', 'reference_text',
  'avatar_id', 'look_id', 'voice_id', 'target_duration_secs', 'aspect_ratio',
  'template_id', 'brand_color',
])
// Columns the client is allowed to PATCH. Status transitions are
// allowed here too because the canvas UI flips status as the user
// moves through the editor (draft → mapping → mapped → editing → …).
const ALLOWED_PATCH = new Set([
  'title', 'topic_prompt', 'reference_url', 'reference_text',
  'avatar_id', 'look_id', 'voice_id', 'target_duration_secs', 'aspect_ratio',
  'template_id', 'brand_color',
  'status', 'script_full_text', 'final_video_url', 'error',
])

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    gateStudio(auth.user.id)

    if (req.method === 'GET') {
      const { id, profile_id: profileId } = req.query

      if (id) {
        // Single video + inline segments ordered by index.
        const rows = await supaFetch(
          `studio_videos?id=eq.${id}&select=*,studio_segments(*)&studio_segments.order=segment_index.asc&limit=1`
        )
        const row = rows?.[0]
        if (!row) return res.status(404).json({ error: 'Not found' })
        await assertProfileAccess(auth.user.id, row.profile_id)
        return res.status(200).json({ video: row })
      }

      if (!profileId) return res.status(400).json({ error: 'profile_id or id required' })
      await assertProfileAccess(auth.user.id, profileId)
      const list = await supaFetch(
        `studio_videos?profile_id=eq.${profileId}&select=id,title,topic_prompt,status,target_duration_secs,aspect_ratio,final_video_url,credits_used,created_at,updated_at&order=created_at.desc&limit=100`
      )
      return res.status(200).json({ videos: list || [] })
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      if (!body.profile_id) return res.status(400).json({ error: 'profile_id required' })
      if (!body.topic_prompt?.trim()) return res.status(400).json({ error: 'topic_prompt required' })
      await assertProfileAccess(auth.user.id, body.profile_id)

      const insertRow = { user_id: auth.user.id, status: 'draft' }
      for (const [k, v] of Object.entries(body)) {
        if (ALLOWED_CREATE.has(k) && v !== undefined) insertRow[k] = v
      }
      const created = await supaFetch('studio_videos', { method: 'POST', body: insertRow })
      const video = Array.isArray(created) ? created[0] : created
      return res.status(201).json({ video })
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id || (req.body && req.body.id)
      if (!id) return res.status(400).json({ error: 'id required' })
      // Verify ownership: load the row to get its profile_id, then check access.
      const existing = await supaFetch(`studio_videos?id=eq.${id}&select=profile_id&limit=1`)
      if (!existing?.[0]) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, existing[0].profile_id)

      const updates = {}
      for (const [k, v] of Object.entries(req.body || {})) {
        if (k === 'id') continue
        if (ALLOWED_PATCH.has(k)) updates[k] = v
      }
      if (!Object.keys(updates).length) return res.status(400).json({ error: 'no editable fields in body' })

      const updated = await supaFetch(`studio_videos?id=eq.${id}`, {
        method: 'PATCH', body: updates,
      })
      const video = Array.isArray(updated) ? updated[0] : updated
      return res.status(200).json({ video })
    }

    if (req.method === 'DELETE') {
      const id = req.query.id
      if (!id) return res.status(400).json({ error: 'id required' })
      const existing = await supaFetch(`studio_videos?id=eq.${id}&select=profile_id&limit=1`)
      if (!existing?.[0]) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, existing[0].profile_id)
      await supaFetch(`studio_videos?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
      return res.status(204).end()
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
