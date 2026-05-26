// Voiceover upload — two-phase signed-URL flow that bypasses
// Vercel's 4.5MB body limit. Same pattern as the per-segment avatar
// uploader at api/studio/segments/upload-avatar.js but scoped to a
// PROFILE rather than an existing segment (no segment exists yet at
// this point — the segments get created by /api/studio/voiceover/segment
// AFTER the upload finalizes).
//
// Phase 1 — POST ?mode=init
//   Body: { profile_id, filename, content_type }
//   Returns: { signed_url, path, token, content_type }
//
// Phase 2 — Browser PUTs the file to signed_url directly.
//
// Phase 3 — POST ?mode=finalize
//   Body: { profile_id, path }
//   Verifies the file landed at the expected prefix and returns the
//   final public URL the client passes into /voiceover/segment.

import { setCors, requireUser, assertProfileAccess } from '../../_lib/supabase.js'
import { gateStudio } from '../_lib/gate.js'

const STUDIO_BUCKET = 'studio-media'
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    gateStudio(auth.user.id)
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'Supabase storage not configured on the server.' })
    }
    const body = req.body || {}
    const profileId = body.profile_id
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })
    await assertProfileAccess(auth.user.id, profileId)

    const mode = req.query.mode || 'init'

    // ── Phase 1: mint signed upload URL ────────────────────────────
    if (mode === 'init') {
      const contentType = body.content_type || 'audio/mpeg'
      // Audio formats Scribe + downstream ffmpeg accept.
      if (!/^audio\/(mpeg|mp3|wav|x-wav|x-m4a|mp4|aac|ogg|flac|webm)$/i.test(contentType)) {
        return res.status(415).json({
          error: `Unsupported content type "${contentType}". Upload MP3, WAV, M4A, AAC, OGG, or FLAC.`,
        })
      }
      const ext = (contentType.split('/')[1] || 'mp3').replace('mpeg', 'mp3').replace('x-', '').slice(0, 4)
      const path = `${profileId}/studio/voiceover/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const signResp = await fetch(
        `${SUPABASE_URL}/storage/v1/object/upload/sign/${STUDIO_BUCKET}/${encodeURI(path)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        },
      )
      if (!signResp.ok) {
        const detail = await signResp.text().catch(() => '')
        return res.status(500).json({ error: `Could not sign upload URL (${signResp.status}): ${detail.slice(0, 200)}` })
      }
      const signed = await signResp.json()
      const absUrl = `${SUPABASE_URL}/storage/v1${signed.url}`
      return res.status(200).json({
        signed_url: absUrl,
        path,
        token: signed.token,
        content_type: contentType,
      })
    }

    // ── Phase 2: finalize — return public URL ──────────────────────
    if (mode === 'finalize') {
      const path = body.path
      if (!path) return res.status(400).json({ error: 'path required' })
      if (!path.startsWith(`${profileId}/studio/voiceover/`)) {
        return res.status(400).json({ error: 'path does not belong to this profile' })
      }
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${STUDIO_BUCKET}/${path}`
      return res.status(200).json({ ok: true, voiceover_url: publicUrl, path })
    }

    return res.status(400).json({ error: `Unknown mode "${mode}". Use init or finalize.` })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || String(err) })
  }
}
