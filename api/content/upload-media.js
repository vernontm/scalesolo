// POST /api/content/upload-media?mode=init
//
// Mints a Supabase signed upload URL for a content post's media in the
// landing-media bucket. The browser BulkUploadView uploads via the RLS
// Supabase client, which a server-to-server caller (the ScaleSolo MCP)
// can't use — so this gives the caller a signed PUT URL to stream the
// file straight to storage, bypassing Vercel's 4.5MB body limit (videos
// are big). Mirrors the two-phase flow in api/profile/visual-references.js.
//
// Body: { profile_id, content_type, kind?: 'video'|'image' }
//   → { signed_url, path, token, public_url, media_type }
//
// After the caller PUTs the bytes to signed_url, it creates the row via
// the existing POST /api/content { media_urls:[public_url], media_type }.

import { setCors, requireUser, assertProfileAccess } from '../_lib/supabase.js'

const BUCKET = 'landing-media'
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

const IMAGE_MIMES = /^image\/(jpeg|png|webp|gif)$/i
const VIDEO_MIMES = /^video\/(mp4|webm|quicktime|x-m4v)$/i

function extFromContentType(ct, kind) {
  const sub = String(ct || '').split('/')[1] || (kind === 'video' ? 'mp4' : 'jpg')
  return sub.replace('jpeg', 'jpg').replace('quicktime', 'mov').replace('x-m4v', 'm4v').slice(0, 4)
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'Supabase storage not configured on the server.' })
    }
    if ((req.query.mode || 'init') !== 'init') {
      return res.status(400).json({ error: `Unknown mode "${req.query.mode}". Use init.` })
    }

    const body = req.body || {}
    const profileId = body.profile_id
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })
    await assertProfileAccess(auth.user.id, profileId)

    const contentType = body.content_type || 'application/octet-stream'
    const isVideo = VIDEO_MIMES.test(contentType) || body.kind === 'video'
    const isImage = IMAGE_MIMES.test(contentType) || body.kind === 'image'
    if (!isVideo && !isImage) {
      return res.status(415).json({ error: `Unsupported content type "${contentType}". Upload an image (jpeg/png/webp/gif) or video (mp4/webm/mov/m4v).` })
    }
    const mediaType = isVideo ? 'video' : 'image'
    const folder = isVideo ? 'videos' : 'images'
    const ext = extFromContentType(contentType, mediaType)
    const path = `${profileId}/bulk/${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`

    const signResp = await fetch(
      `${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${encodeURI(path)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    )
    if (!signResp.ok) {
      const detail = await signResp.text().catch(() => '')
      return res.status(500).json({ error: `Could not sign upload URL (${signResp.status}): ${detail.slice(0, 200)}` })
    }
    const signed = await signResp.json()
    return res.status(200).json({
      signed_url: `${SUPABASE_URL}/storage/v1${signed.url}`,
      path,
      token: signed.token,
      content_type: contentType,
      public_url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`,
      media_type: mediaType,
    })
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || String(e) })
  }
}
