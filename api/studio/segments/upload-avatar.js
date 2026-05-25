// POST /api/studio/segments/upload-avatar?id=<segment_id>
//
// Lets users plug their own rendered avatar video into a segment. The
// existing avatar_video_url column is reused — when populated by this
// endpoint, the orchestrator's "already done" check fires and HeyGen
// is skipped on the next render. Perfect for users who want to render
// avatars outside ScaleSolo (own platform / more credits / different
// avatar provider).
//
// Body: multipart/form-data with field "file" — the MP4 to upload.
//   Max 100MB (Vercel function memory).
//   Accepts video/mp4. Other types rejected with 415.
//
// Workflow the user follows:
//   1. Generate voice only via the editor's "Voice only" button.
//   2. Download voice for each avatar segment via the SegmentRow link.
//   3. Render those voices through their own avatar platform.
//   4. Upload each finished avatar MP4 here, paired to its segment.
//   5. Render the video — the worker pulls these uploads instead of
//      calling HeyGen for those segments.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../../_lib/supabase.js'
import { gateStudio } from '../_lib/gate.js'

const STUDIO_BUCKET = 'studio-media'
const MAX_BYTES = 100 * 1024 * 1024  // 100MB safety cap
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

export const config = {
  api: {
    // We parse the body ourselves (raw buffer) — Vercel's default
    // body parser doesn't handle multipart cleanly without an extra
    // dependency. Below we just read the raw buffer + extract the
    // file via a tiny multipart parser.
    bodyParser: false,
  },
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BYTES) {
        reject(new Error(`File exceeds ${MAX_BYTES / 1024 / 1024}MB limit`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Minimal multipart/form-data parser. Pulls the first file part out.
// Not RFC-grade — good enough for a single-file form post from the UI.
function extractFirstFile(buf, boundary) {
  const delim = Buffer.from(`--${boundary}`)
  const headerSep = Buffer.from('\r\n\r\n')
  let pos = buf.indexOf(delim)
  if (pos === -1) return null
  pos += delim.length
  // Walk each part until we find one with a filename.
  while (pos < buf.length) {
    if (buf.slice(pos, pos + 2).toString() === '--') return null  // end of body
    pos += 2  // skip \r\n after boundary
    const headerEnd = buf.indexOf(headerSep, pos)
    if (headerEnd === -1) return null
    const headers = buf.slice(pos, headerEnd).toString('utf8')
    const bodyStart = headerEnd + headerSep.length
    const nextBoundary = buf.indexOf(delim, bodyStart)
    if (nextBoundary === -1) return null
    const bodyEnd = nextBoundary - 2  // strip trailing \r\n before boundary
    const partBody = buf.slice(bodyStart, bodyEnd)
    const fileMatch = headers.match(/filename="([^"]+)"/i)
    const typeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i)
    if (fileMatch) {
      return {
        filename: fileMatch[1],
        contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
        body: partBody,
      }
    }
    pos = nextBoundary + delim.length
  }
  return null
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

    // Load segment + verify access via its parent video.
    const segs = await supaFetch(`studio_segments?id=eq.${segmentId}&select=*,studio_videos(*)`)
    const seg = segs?.[0]
    if (!seg) return res.status(404).json({ error: 'Segment not found' })
    const video = seg.studio_videos
    if (!video) return res.status(404).json({ error: 'Parent video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    if (seg.segment_type !== 'avatar') {
      return res.status(400).json({
        error: `Only avatar segments can receive a custom avatar video upload. This segment is ${seg.segment_type}.`,
      })
    }

    // Multipart parse.
    const contentType = req.headers['content-type'] || ''
    const boundaryMatch = contentType.match(/boundary=(.+)$/i)
    if (!boundaryMatch) {
      return res.status(400).json({ error: 'multipart/form-data with boundary required' })
    }
    const buf = await readRawBody(req)
    const file = extractFirstFile(buf, boundaryMatch[1])
    if (!file) return res.status(400).json({ error: 'No file part found in request body' })
    if (!file.contentType.startsWith('video/')) {
      return res.status(415).json({
        error: `Unsupported file type "${file.contentType}". Upload an MP4 (video/mp4).`,
      })
    }

    // Upload to studio-media/<profile>/studio/external-avatars/<seg_id>.<ext>.
    // Same path convention as HeyGen-generated avatars so they're
    // grouped under the profile prefix. Direct Supabase Storage REST
    // call with service key — same pattern as poll-assets.js.
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'Supabase storage not configured on the server.' })
    }
    const ext = file.contentType.includes('quicktime') ? 'mov' : 'mp4'
    const path = `${video.profile_id}/studio/external-avatars/${segmentId}-${Date.now()}.${ext}`
    const up = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${STUDIO_BUCKET}/${encodeURI(path)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': file.contentType,
          'x-upsert': 'true',
        },
        body: file.body,
      },
    )
    if (!up.ok) {
      const detail = await up.text().catch(() => '')
      return res.status(500).json({ error: `Storage upload ${up.status}: ${detail.slice(0, 200)}` })
    }
    const finalUrl = `${SUPABASE_URL}/storage/v1/object/public/${STUDIO_BUCKET}/${path}`

    // Patch the segment. Mark status=ready so the editor immediately
    // shows the row as good-to-render.
    await supaFetch(`studio_segments?id=eq.${segmentId}`, {
      method: 'PATCH',
      body: { avatar_video_url: finalUrl, status: 'ready', error: null },
      prefer: 'return=minimal',
    })

    return res.status(200).json({
      ok: true,
      avatar_video_url: finalUrl,
      filename: file.filename,
      bytes: file.body.length,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || String(err) })
  }
}
