// POST /api/images/upload-reference
// Body: { profile_id, base64, fileName? }
// Returns: { url, expiresAt }
//
// Proxies a browser-supplied file (as a data: URL / base64) to KIE's
// free file-upload service. The returned URL is CORS-friendly and works
// as an image_input for KIE's generation models. Heads up: KIE expires
// uploaded files after ~3 days, so this is intentionally only used for
// "active workflow" reference images — generated results still go through
// the Supabase mirror so library entries stay permanent.

import { setCors, requireUser, assertProfileAccess } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, base64, fileName } = req.body || {}
    if (!profile_id || !base64) {
      return res.status(400).json({ error: 'profile_id + base64 (data URL) required' })
    }
    await assertProfileAccess(auth.user.id, profile_id)

    const apiKey = process.env.KIE_API_KEY
    if (!apiKey) return res.status(500).json({ error: 'KIE_API_KEY not configured' })

    const r = await fetch('https://kieai.redpandaai.co/api/file-base64-upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        base64Data: base64,
        uploadPath: `scalesolo/spaces/${profile_id}`,
        fileName: fileName || `ref-${Date.now()}.png`,
      }),
    })
    const body = await r.json().catch(() => ({}))
    const url = body?.data?.fileUrl || body?.data?.downloadUrl
    if (!r.ok || !url) {
      return res.status(502).json({ error: body?.msg || `KIE upload failed (${r.status})`, raw: body })
    }
    return res.status(200).json({ url, expiresAt: body?.data?.expiresAt || null })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
