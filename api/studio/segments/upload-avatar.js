// Avatar video upload — two-phase flow that bypasses Vercel's 4.5MB
// serverless body limit. The browser uploads the file DIRECTLY to
// Supabase Storage using a short-lived signed URL we mint here.
//
// Phase 1 — POST /api/studio/segments/upload-avatar?id=<segId>&mode=init
//   Body: { filename, content_type }
//   Returns: { signed_url, path, token }
//
// Phase 2 — Browser PUTs the file to signed_url (no Vercel hop).
//
// Phase 3 — POST /api/studio/segments/upload-avatar?id=<segId>&mode=finalize
//   Body: { path }
//   Patches segment.avatar_video_url to the public URL and flips
//   status='ready'.
//
// Workflow the user follows:
//   1. Generate voice only via the editor's "Voice + B-roll" checkbox
//      with avatar unchecked.
//   2. Download voice for each avatar segment.
//   3. Render those voices through their own avatar platform.
//   4. Upload each finished MP4 here, paired to its segment.
//   5. Render the video — the worker pulls these uploads instead of
//      calling HeyGen for those segments.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../../_lib/supabase.js'
import { gateStudio } from '../_lib/gate.js'

const STUDIO_BUCKET = 'studio-media'
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

async function loadSegmentAndAuthorize(auth, segmentId) {
  const segs = await supaFetch(`studio_segments?id=eq.${segmentId}&select=*,studio_videos(*)`)
  const seg = segs?.[0]
  if (!seg) return { error: { status: 404, message: 'Segment not found' } }
  const video = seg.studio_videos
  if (!video) return { error: { status: 404, message: 'Parent video not found' } }
  await assertProfileAccess(auth.user.id, video.profile_id)
  if (seg.segment_type !== 'avatar') {
    return { error: {
      status: 400,
      message: `Only avatar segments can receive a custom avatar video. This segment is ${seg.segment_type}.`,
    } }
  }
  return { seg, video }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    gateStudio(auth.user.id)
    const segmentId = req.query.id
    if (!segmentId) return res.status(400).json({ error: 'segment id required in query' })
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'Supabase storage not configured on the server.' })
    }

    const { seg, video, error } = await loadSegmentAndAuthorize(auth, segmentId)
    if (error) return res.status(error.status).json({ error: error.message })

    const mode = req.query.mode || 'init'

    // ── Phase 1: mint a signed upload URL ───────────────────────────
    // Storage's signed upload URLs let the browser PUT the file
    // directly to S3 (the storage backend) without the bytes ever
    // touching Vercel. Token is single-use and short-lived (~2h).
    if (mode === 'init') {
      const body = req.body || {}
      const contentType = body.content_type || 'video/mp4'
      if (!contentType.startsWith('video/')) {
        return res.status(415).json({
          error: `Unsupported content type "${contentType}". Upload an MP4 / MOV.`,
        })
      }
      const ext = contentType.includes('quicktime') ? 'mov' : 'mp4'
      const path = `${video.profile_id}/studio/external-avatars/${segmentId}-${Date.now()}.${ext}`
      // Storage REST: POST /storage/v1/object/upload/sign/<bucket>/<path>
      // Returns { url, token } where the browser does:
      //   PUT https://<project>.supabase.co<url>
      //   with x-upsert + auth header. We hand the relative URL back.
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
      // signed.url is like "/object/upload/sign/<bucket>/<path>?token=..."
      // — prepend SUPABASE_URL/storage/v1 so the browser hits an
      // absolute URL.
      const absUrl = `${SUPABASE_URL}/storage/v1${signed.url}`
      return res.status(200).json({
        signed_url: absUrl,
        path,
        token: signed.token,
        content_type: contentType,
      })
    }

    // ── Phase 2: finalize ───────────────────────────────────────────
    // Browser tells us the upload landed at <path>. We patch the
    // segment so the editor + render path pick up the new URL.
    if (mode === 'finalize') {
      const body = req.body || {}
      const path = body.path
      if (!path) return res.status(400).json({ error: 'path required' })
      // Guard: path must live under the user's profile prefix so a
      // client can't claim someone else's upload.
      if (!path.startsWith(`${video.profile_id}/studio/external-avatars/`)) {
        return res.status(400).json({ error: 'path does not belong to this video' })
      }
      const finalUrl = `${SUPABASE_URL}/storage/v1/object/public/${STUDIO_BUCKET}/${path}`
      await supaFetch(`studio_segments?id=eq.${segmentId}`, {
        method: 'PATCH',
        body: { avatar_video_url: finalUrl, status: 'ready', error: null },
        prefer: 'return=minimal',
      })
      return res.status(200).json({ ok: true, avatar_video_url: finalUrl })
    }

    return res.status(400).json({ error: `Unknown mode "${mode}". Use init or finalize.` })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || String(err) })
  }
}
