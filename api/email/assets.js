// Images and downloadable files that go INSIDE a campaign email.
//
// An inbox has no page to resolve a relative path against, and Gmail and
// Outlook strip inline data: URIs, so an image only appears for the
// subscriber if it lives at an absolute https URL that anyone can fetch.
// This endpoint puts it there.
//
//   POST ?mode=init { profile_id, content_type, filename? }
//     -> { signed_url, token, path, public_url, img_html, kind }
//
// Two-phase on purpose, mirroring api/content/upload-media.js: the caller
// PUTs the bytes straight to Supabase storage, so a big attachment never has
// to fit inside Vercel's 4.5MB request body. Both the composer in
// src/pages/Email.jsx and the upload_email_image MCP tool use this one path,
// so there is a single place where the public URL is minted.
//
// Bucket is the existing public `landing-media`, under <profile_id>/email/.
// Deliberately not a new bucket: a new one needs a dashboard/migration step
// that a session cannot apply, which would leave this endpoint returning
// signed URLs into a bucket that does not exist yet.

import { setCors, requireUser, assertMinRole } from '../_lib/supabase.js'

const BUCKET = 'landing-media'
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

// What is worth embedding in, or linking from, an email. No video: no mail
// client plays it inline, and a 30MB attachment is how a sending domain earns
// a spam reputation. Link to a landing page for that instead.
const IMAGE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
const FILE = {
  'application/pdf': 'pdf',
  'text/calendar': 'ics',
}

// A safe-ish slug of the original filename, kept in the path so a human
// browsing storage can tell a logo from a menu scan.
function slug(name) {
  return String(name || '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

// Email-safe <img>. width/height and the max-width style are not polish:
// without them Outlook renders the image at its intrinsic pixel size and
// blows out the 600px shell, and a missing border:0 draws a blue frame
// around any image wrapped in a link.
export function imgHtml(url, { alt = '' } = {}) {
  return `<img src="${url}" alt="${String(alt).replace(/"/g, '&quot;')}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0;outline:none;text-decoration:none;margin:0 auto 16px;" />`
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'Supabase storage is not configured on the server.' })
    }
    const mode = String(req.query?.mode || 'init')
    if (mode !== 'init') return res.status(400).json({ error: `Unknown mode "${mode}". Use init.` })

    const body = req.body || {}
    const profileId = body.profile_id
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })
    // Editor, not just viewer: this writes a permanently public file under
    // the brand's folder.
    await assertMinRole(auth.user.id, profileId, 'editor')

    const contentType = String(body.content_type || '').toLowerCase().split(';')[0].trim()
    const ext = IMAGE[contentType] || FILE[contentType]
    if (!ext) {
      return res.status(415).json({
        error: `"${contentType || 'unknown'}" cannot go in an email. Use a JPEG, PNG, GIF or WebP image, or a PDF.`,
      })
    }
    const kind = IMAGE[contentType] ? 'image' : 'file'
    const stem = slug(body.filename)
    const path = `${profileId}/email/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${stem ? `-${stem}` : ''}.${ext}`

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
      return res.status(500).json({ error: `Could not sign the upload URL (${signResp.status}): ${detail.slice(0, 200)}` })
    }
    const signed = await signResp.json()
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`
    return res.status(200).json({
      signed_url: `${SUPABASE_URL}/storage/v1${signed.url}`,
      token: signed.token,
      path,
      content_type: contentType,
      public_url: publicUrl,
      kind,
      // Ready to paste into the body, so nobody hand-writes an <img> that
      // breaks in Outlook. Built here and nowhere else, so the composer and
      // the MCP tool cannot drift apart on what email-safe markup is.
      img_html: kind === 'image' ? imgHtml(publicUrl, { alt: body.alt ?? body.filename ?? '' }) : null,
    })
  } catch (e) {
    if (e?.status === 403) return res.status(403).json({ error: e.message || 'Forbidden' })
    return res.status(e?.status || 500).json({ error: e?.message || String(e) })
  }
}
