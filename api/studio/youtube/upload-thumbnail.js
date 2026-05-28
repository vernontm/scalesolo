// POST /api/studio/youtube/upload-thumbnail
//
// Multipart upload of a custom YouTube thumbnail image. Returns the
// public URL of the stored image so the Schedule modal can pass it
// to upload-post.com as `youtube_thumbnail`. YouTube custom thumbnails
// must be 2MB or smaller, 1280x720 (16:9) recommended, JPEG or PNG.
//
// Body (multipart/form-data): file=<image>, studio_video_id=<uuid>
// Returns: { url }

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../../_lib/supabase.js'
import { gateStudio } from '../_lib/gate.js'

export const config = {
  api: { bodyParser: false },
  maxDuration: 30,
}

const STUDIO_BUCKET = 'studio-media'
const MAX_BYTES = 2 * 1024 * 1024  // 2MB — YouTube's limit
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])

// Tiny multipart parser. The upload is one file + one field — we don't
// need the full @vercel/blob or formidable; parsing the boundary inline
// keeps the cold-start small.
async function readMultipart(req) {
  const ct = req.headers['content-type'] || ''
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  if (!m) throw new Error('Missing multipart boundary')
  const boundary = `--${m[1] || m[2]}`
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const buf = Buffer.concat(chunks)
  const parts = []
  let cursor = 0
  while (cursor < buf.length) {
    const start = buf.indexOf(boundary, cursor)
    if (start < 0) break
    const headerStart = start + boundary.length + 2
    const headerEnd = buf.indexOf('\r\n\r\n', headerStart)
    if (headerEnd < 0) break
    const headers = buf.slice(headerStart, headerEnd).toString()
    const bodyStart = headerEnd + 4
    const nextBoundary = buf.indexOf(boundary, bodyStart)
    const bodyEnd = nextBoundary < 0 ? buf.length : nextBoundary - 2
    parts.push({ headers, body: buf.slice(bodyStart, bodyEnd) })
    cursor = nextBoundary < 0 ? buf.length : nextBoundary
  }
  return parts
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    gateStudio(auth.user.id)

    const parts = await readMultipart(req)
    let fileBuf = null
    let fileMime = null
    let studio_video_id = null
    for (const p of parts) {
      const nameMatch = p.headers.match(/name="([^"]+)"/i)
      if (!nameMatch) continue
      if (nameMatch[1] === 'file') {
        const mimeMatch = p.headers.match(/Content-Type:\s*([^\r\n]+)/i)
        fileMime = mimeMatch?.[1]?.trim() || 'image/jpeg'
        fileBuf = p.body
      } else if (nameMatch[1] === 'studio_video_id') {
        studio_video_id = p.body.toString().trim()
      }
    }
    if (!fileBuf?.length) return res.status(400).json({ error: 'No file uploaded.' })
    if (!studio_video_id) return res.status(400).json({ error: 'studio_video_id required.' })
    if (fileBuf.length > MAX_BYTES) {
      return res.status(413).json({ error: `Thumbnail must be ≤ 2MB (got ${(fileBuf.length / 1024 / 1024).toFixed(2)}MB).` })
    }
    if (!ALLOWED_MIMES.has(fileMime)) {
      return res.status(415).json({ error: `Unsupported MIME: ${fileMime}. Use JPEG, PNG, or WebP.` })
    }

    // Look up profile_id from the video so we can scope storage by it,
    // matching how every other studio upload is filed.
    const videoRows = await supaFetch(`studio_videos?id=eq.${studio_video_id}&select=profile_id&limit=1`)
    const video = videoRows?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found.' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    const ext = fileMime === 'image/png' ? 'png' : fileMime === 'image/webp' ? 'webp' : 'jpg'
    const path = `${video.profile_id}/studio/youtube-thumbnails/${studio_video_id}-${Date.now()}.${ext}`
    const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
    const up = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${STUDIO_BUCKET}/${encodeURI(path)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': fileMime,
          'x-upsert': 'true',
        },
        body: fileBuf,
      },
    )
    if (!up.ok) {
      const detail = await up.text().catch(() => '')
      return res.status(502).json({ error: `Storage upload failed: ${up.status} ${detail.slice(0, 200)}` })
    }
    const url = `${SUPABASE_URL}/storage/v1/object/public/${STUDIO_BUCKET}/${path}`
    return res.status(200).json({ url, bytes: fileBuf.length })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
