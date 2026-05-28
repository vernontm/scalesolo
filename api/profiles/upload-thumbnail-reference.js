// POST /api/profiles/upload-thumbnail-reference
//
// Uploads a YouTube thumbnail reference image to studio-media storage
// and appends its URL to profiles.youtube_thumbnail_references.
// Used by the brand-profile editor to build up a small library of
// reference thumbnails that Claude analyzes when generating new
// thumbnails for Studio videos.
//
// Body (multipart/form-data): file=<image>, profile_id=<uuid>
// Returns: { url, references } where `references` is the updated array.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

export const config = {
  api: { bodyParser: false },
  maxDuration: 30,
}

const STUDIO_BUCKET = 'studio-media'
const MAX_BYTES = 5 * 1024 * 1024  // 5MB is plenty for reference thumbs
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])

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
    const parts = await readMultipart(req)
    let fileBuf = null
    let fileMime = null
    let profile_id = null
    for (const p of parts) {
      const nameMatch = p.headers.match(/name="([^"]+)"/i)
      if (!nameMatch) continue
      if (nameMatch[1] === 'file') {
        const mimeMatch = p.headers.match(/Content-Type:\s*([^\r\n]+)/i)
        fileMime = mimeMatch?.[1]?.trim() || 'image/jpeg'
        fileBuf = p.body
      } else if (nameMatch[1] === 'profile_id') {
        profile_id = p.body.toString().trim()
      }
    }
    if (!fileBuf?.length) return res.status(400).json({ error: 'No file uploaded.' })
    if (!profile_id) return res.status(400).json({ error: 'profile_id required.' })
    if (fileBuf.length > MAX_BYTES) {
      return res.status(413).json({ error: `Reference image must be ≤ 5MB (got ${(fileBuf.length / 1024 / 1024).toFixed(2)}MB).` })
    }
    if (!ALLOWED_MIMES.has(fileMime)) {
      return res.status(415).json({ error: `Unsupported MIME: ${fileMime}. Use JPEG, PNG, or WebP.` })
    }
    await assertProfileAccess(auth.user.id, profile_id)

    const ext = fileMime === 'image/png' ? 'png' : fileMime === 'image/webp' ? 'webp' : 'jpg'
    const path = `${profile_id}/youtube-thumbnail-refs/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
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

    // Append to the profile's references array. Read-modify-write —
    // small enough array that we don't need a real append op.
    const existing = await supaFetch(`profiles?id=eq.${profile_id}&select=youtube_thumbnail_references&limit=1`)
    const currentRefs = Array.isArray(existing?.[0]?.youtube_thumbnail_references)
      ? existing[0].youtube_thumbnail_references
      : []
    // Cap at 6 references — Claude vision input cost climbs linearly and
    // 4-6 is plenty for style inference.
    const nextRefs = [...currentRefs, url].slice(-6)
    await supaFetch(`profiles?id=eq.${profile_id}`, {
      method: 'PATCH',
      body: { youtube_thumbnail_references: nextRefs },
      prefer: 'return=minimal',
    })
    return res.status(200).json({ url, references: nextRefs })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
