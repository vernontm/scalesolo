// Brand visual references — Threads screenshots, carousel slide
// examples, branded graphics. These get fed into Claude prompts via
// brand-context so generated posts match the brand's visual + copy
// patterns. Mirrors the two-phase signed-URL upload flow used by
// studio voiceover so files bypass Vercel's 4.5MB body limit.
//
// Routes:
//
//   GET    /api/profile/visual-references?profile_id=<uuid>&kind=<optional>
//          → { references: [...] } ordered newest-first
//
//   POST   /api/profile/visual-references?mode=init
//          Body: { profile_id, filename, content_type, kind }
//          → { signed_url, path, public_url, content_type, kind }
//
//   POST   /api/profile/visual-references?mode=finalize
//          Body: { profile_id, path, kind, notes?, width_px?, height_px? }
//          → { reference } — inserts the brand_visual_references row
//                            and returns it
//
//   PATCH  /api/profile/visual-references?id=<uuid>
//          Body: { kind?, notes?, caption? } — partial update
//
//   DELETE /api/profile/visual-references?id=<uuid>
//          Also removes the underlying storage object on best-effort.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

const BUCKET = 'brand-references'
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

const ALLOWED_KINDS = new Set(['threads', 'carousel', 'graphic', 'thumbnail', 'other'])
const ALLOWED_MIMES = /^image\/(jpeg|png|webp|gif)$/i

function extFromContentType(ct) {
  const sub = String(ct || '').split('/')[1] || 'jpg'
  return sub.replace('jpeg', 'jpg').slice(0, 4)
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'Supabase storage not configured on the server.' })
    }

    // ── LIST ────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const profileId = String(req.query.profile_id || '').trim()
      if (!profileId) return res.status(400).json({ error: 'profile_id required' })
      await assertProfileAccess(auth.user.id, profileId)
      const kindFilter = req.query.kind ? `&kind=eq.${encodeURIComponent(req.query.kind)}` : ''
      const refs = await supaFetch(
        `brand_visual_references?profile_id=eq.${profileId}${kindFilter}&order=created_at.desc&limit=200`,
      )
      return res.status(200).json({ references: refs || [] })
    }

    // ── PATCH (partial update of a row) ─────────────────────────────
    if (req.method === 'PATCH') {
      const id = String(req.query.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id required' })
      const existing = await supaFetch(`brand_visual_references?id=eq.${id}&select=profile_id&limit=1`)
      const row = existing?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, row.profile_id)

      const body = req.body || {}
      const patch = { updated_at: new Date().toISOString() }
      if (body.kind !== undefined) {
        if (!ALLOWED_KINDS.has(body.kind)) return res.status(400).json({ error: 'invalid kind' })
        patch.kind = body.kind
      }
      if (body.notes !== undefined) patch.notes = String(body.notes || '').slice(0, 2000) || null
      if (body.caption !== undefined) patch.caption = String(body.caption || '').slice(0, 4000) || null

      const updated = await supaFetch(`brand_visual_references?id=eq.${id}`, {
        method: 'PATCH', body: patch,
      })
      return res.status(200).json({ reference: Array.isArray(updated) ? updated[0] : updated })
    }

    // ── DELETE ──────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = String(req.query.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id required' })
      const existing = await supaFetch(
        `brand_visual_references?id=eq.${id}&select=profile_id,storage_path&limit=1`,
      )
      const row = existing?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, row.profile_id)

      // Best-effort storage cleanup. If it 404s the row delete still
      // proceeds — better to have an orphaned DB row gone than to
      // block the user on a stale bucket file.
      try {
        await fetch(
          `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(row.storage_path)}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } },
        )
      } catch { /* storage delete failed — still drop the row */ }

      await supaFetch(`brand_visual_references?id=eq.${id}`, {
        method: 'DELETE', prefer: 'return=minimal',
      })
      return res.status(204).end()
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const mode = req.query.mode || 'init'
    const body = req.body || {}
    const profileId = body.profile_id
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })
    await assertProfileAccess(auth.user.id, profileId)

    // ── INIT: mint signed upload URL ────────────────────────────────
    if (mode === 'init') {
      const contentType = body.content_type || 'image/jpeg'
      if (!ALLOWED_MIMES.test(contentType)) {
        return res.status(415).json({ error: `Unsupported content type "${contentType}". Upload JPEG, PNG, WEBP, or GIF.` })
      }
      const kind = body.kind || 'other'
      if (!ALLOWED_KINDS.has(kind)) return res.status(400).json({ error: 'invalid kind' })

      const ext = extFromContentType(contentType)
      const path = `${profileId}/${kind}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const signResp = await fetch(
        `${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${encodeURI(path)}`,
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
      return res.status(200).json({
        signed_url: `${SUPABASE_URL}/storage/v1${signed.url}`,
        path,
        token: signed.token,
        content_type: contentType,
        public_url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`,
        kind,
      })
    }

    // ── FINALIZE: insert the row ───────────────────────────────────
    if (mode === 'finalize') {
      const path = body.path
      if (!path) return res.status(400).json({ error: 'path required' })
      if (!path.startsWith(`${profileId}/`)) {
        return res.status(400).json({ error: 'path does not belong to this profile' })
      }
      const kind = body.kind || 'other'
      if (!ALLOWED_KINDS.has(kind)) return res.status(400).json({ error: 'invalid kind' })

      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`
      const inserted = await supaFetch('brand_visual_references', {
        method: 'POST',
        body: {
          profile_id: profileId,
          kind,
          storage_path: path,
          public_url: publicUrl,
          notes: body.notes ? String(body.notes).slice(0, 2000) : null,
          width_px: Number.isFinite(body.width_px) ? body.width_px : null,
          height_px: Number.isFinite(body.height_px) ? body.height_px : null,
        },
      })
      const row = Array.isArray(inserted) ? inserted[0] : inserted
      return res.status(201).json({ reference: row })
    }

    return res.status(400).json({ error: `Unknown mode "${mode}". Use init or finalize.` })
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || String(e) })
  }
}
