// Screenshot upload — two-phase signed-URL flow that mirrors
// upload-avatar.js. The browser uploads the image DIRECTLY to Supabase
// Storage so we never hit Vercel's 4.5MB serverless body limit.
//
// Phase 1 — POST /api/studio/segments/upload-screenshot?id=<segId>&mode=init
//   Body: { filename, content_type }
//   Returns: { signed_url, path, token, content_type }
//
// Phase 2 — Browser PUTs the file to signed_url.
//
// Phase 3 — POST /api/studio/segments/upload-screenshot?id=<segId>&mode=finalize
//   Body: { path }
//   Patches segment.image_url to the public URL and flips
//   status='ready'. The render worker reads image_url + treats the
//   segment as a screenshot composition based on segment_type.

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
  if (seg.segment_type !== 'screenshot') {
    return { error: {
      status: 400,
      message: `Only screenshot segments can receive a screenshot upload. This segment is ${seg.segment_type}.`,
    } }
  }
  return { seg, video }
}

function extFromContentType(ct) {
  if (ct === 'image/png')  return 'png'
  if (ct === 'image/jpeg') return 'jpg'
  if (ct === 'image/webp') return 'webp'
  if (ct === 'image/gif')  return 'gif'
  // Video formats — the segment composition renders <video> instead of
  // <img> when the upload's extension matches. mp4 covers the common
  // case (phone exports, screen recorders); mov is Apple QuickTime
  // (iPhone defaults); webm is for web recorders.
  if (ct === 'video/mp4')       return 'mp4'
  if (ct === 'video/quicktime') return 'mov'
  if (ct === 'video/webm')      return 'webm'
  return 'png'
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

    if (mode === 'init') {
      const body = req.body || {}
      const contentType = body.content_type || 'image/png'
      // Allow both image and video uploads. The composition detects
      // which one was uploaded from the URL extension and renders
      // either an <img> (static) or <video> (plays back during the
      // segment, hard-cut at the next scene boundary).
      const isImage = contentType.startsWith('image/')
      const isVideo = ['video/mp4', 'video/quicktime', 'video/webm'].includes(contentType)
      if (!isImage && !isVideo) {
        return res.status(415).json({
          error: `Unsupported content type "${contentType}". Upload PNG/JPG/WEBP image or MP4/MOV/WEBM video.`,
        })
      }
      const ext = extFromContentType(contentType)
      const path = `${video.profile_id}/studio/screenshots/${segmentId}-${Date.now()}.${ext}`
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

    if (mode === 'finalize') {
      const body = req.body || {}
      const path = body.path
      if (!path) return res.status(400).json({ error: 'path required' })
      if (!path.startsWith(`${video.profile_id}/studio/screenshots/`)) {
        return res.status(400).json({ error: 'path does not belong to this video' })
      }
      const finalUrl = `${SUPABASE_URL}/storage/v1/object/public/${STUDIO_BUCKET}/${path}`
      await supaFetch(`studio_segments?id=eq.${segmentId}`, {
        method: 'PATCH',
        body: { image_url: finalUrl, status: 'ready', error: null },
        prefer: 'return=minimal',
      })
      return res.status(200).json({ ok: true, image_url: finalUrl })
    }

    return res.status(400).json({ error: `Unknown mode "${mode}". Use init or finalize.` })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || String(err) })
  }
}
