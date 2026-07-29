// Brand real-asset library — the client's actual photos and videos of
// their product/food/venue. This is the fidelity source of truth for
// campaign media generation: anything showing the real product is
// generated FROM these as locked references (Kie image-to-image +
// OBJECT exact-lock) so the product never drifts into an AI fabrication.
//
// Distinct from api/profile/visual-references.js, which holds style-only
// screenshots/exemplars. Mirrors that file's two-phase signed-URL upload
// (init → signed PUT → finalize) to bypass Vercel's 4.5MB body limit,
// but targets the brand-assets bucket, allows video, carries a category
// + exact-lock flag, and runs a Claude vision analysis on image finalize
// so the campaign planner can reference assets by id.
//
// Routes:
//   GET    ?profile_id=<uuid>[&category=<cat>]        → { assets: [...] }
//   POST   ?mode=init    { profile_id, content_type, category }
//                        → { signed_url, path, token, public_url, media_type, category }
//   POST   ?mode=finalize{ profile_id, path, category, label?, width_px?, height_px? }
//                        → { asset }   (vision_json filled in for images)
//   PATCH  ?id=<uuid>    { label?, category?, lock_exact? } → { asset }
//   DELETE ?id=<uuid>    (also removes the storage object, best-effort)

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { message } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'

export const config = { maxDuration: 60 }

const BUCKET = 'brand-assets'
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

const ALLOWED_CATEGORIES = new Set(['food', 'product', 'interior', 'exterior', 'lifestyle', 'other'])
const IMAGE_MIMES = /^image\/(jpeg|png|webp|gif)$/i
const VIDEO_MIMES = /^video\/(mp4|webm|quicktime)$/i

function extFromContentType(ct) {
  const sub = String(ct || '').split('/')[1] || 'jpg'
  return sub.replace('jpeg', 'jpg').replace('quicktime', 'mov').slice(0, 4)
}

// Claude vision read of a real product/food photo. Returns a compact
// structured description the planner uses to (a) reference the asset by
// what it actually shows and (b) build "keep this exact" generation
// prompts. Best-effort: any failure returns null and the asset is still
// saved (the user can label it manually).
async function analyzeImage(publicUrl, brandMd) {
  try {
    const prompt = `You are cataloguing a REAL product/food/venue photo for a brand's asset library. This exact image will later be used as a locked reference for AI image generation, so the AI must never alter what the product actually looks like.

Return ONLY a JSON object (no prose, no code fences) with these keys:
{
  "label": "3-5 word name, e.g. \\"grilled lamb chops plate\\"",
  "category": one of "food" | "product" | "interior" | "exterior" | "lifestyle" | "other",
  "subject": "the main thing shown, one short phrase",
  "description": "1-2 sentence factual description of what's in the frame",
  "key_details": ["specific visual facts that MUST be preserved, e.g. \\"char marks on the meat\\", \\"white oval plate\\", \\"lemon wedge garnish\\""],
  "dominant_colors": ["plain color names"],
  "do_not_alter": ["the elements an AI must reproduce exactly, phrased as instructions"]
}

Be concrete and specific to THIS image. Name the EXACT dish/product, never a vague category: never label something just "meat", "food", "dish", or "platter" — identify the specific item (e.g. "chicken shawarma plate", "beef shawarma", "kafta", "lamb chops"). If you genuinely cannot tell the specific dish from the image, set label to "NEEDS LABEL: <your best short description>" so a human can correct it, rather than guessing a generic category. Never use em dashes.

<brand_context>
${brandMd || '(no brand context)'}
</brand_context>`
    const resp = await message({
      max_tokens: 700,
      system: 'You analyze real product/food photos and return strict JSON catalog entries. Output JSON only.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: publicUrl } },
          { type: 'text', text: prompt },
        ],
      }],
    })
    const text = (resp?.content?.find?.((b) => b.type === 'text')?.text || '').trim()
    if (!text) return null
    // Tolerate stray fences / prose around the JSON.
    const jsonStr = text.startsWith('{') ? text : (text.match(/\{[\s\S]*\}/)?.[0] || '')
    if (!jsonStr) return null
    const parsed = JSON.parse(jsonStr)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
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
      const catFilter = req.query.category ? `&category=eq.${encodeURIComponent(req.query.category)}` : ''
      const assets = await supaFetch(
        `brand_assets?profile_id=eq.${profileId}${catFilter}&order=created_at.desc&limit=300`,
      )
      return res.status(200).json({ assets: assets || [] })
    }

    // ── PATCH (label / category / lock_exact) ───────────────────────
    if (req.method === 'PATCH') {
      const id = String(req.query.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id required' })
      const existing = await supaFetch(`brand_assets?id=eq.${id}&select=profile_id&limit=1`)
      const row = existing?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, row.profile_id)

      const body = req.body || {}
      const patch = { updated_at: new Date().toISOString() }
      if (body.label !== undefined) patch.label = String(body.label || '').slice(0, 120) || null
      if (body.category !== undefined) {
        if (!ALLOWED_CATEGORIES.has(body.category)) return res.status(400).json({ error: 'invalid category' })
        patch.category = body.category
      }
      if (body.lock_exact !== undefined) patch.lock_exact = !!body.lock_exact

      const updated = await supaFetch(`brand_assets?id=eq.${id}`, { method: 'PATCH', body: patch })
      return res.status(200).json({ asset: Array.isArray(updated) ? updated[0] : updated })
    }

    // ── DELETE ──────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = String(req.query.id || '').trim()
      if (!id) return res.status(400).json({ error: 'id required' })
      const existing = await supaFetch(`brand_assets?id=eq.${id}&select=profile_id,storage_path&limit=1`)
      const row = existing?.[0]
      if (!row) return res.status(404).json({ error: 'Not found' })
      await assertProfileAccess(auth.user.id, row.profile_id)
      try {
        await fetch(
          `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(row.storage_path)}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } },
        )
      } catch { /* storage delete failed — still drop the row */ }
      await supaFetch(`brand_assets?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' })
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
      const isVideo = VIDEO_MIMES.test(contentType)
      if (!IMAGE_MIMES.test(contentType) && !isVideo) {
        return res.status(415).json({ error: `Unsupported content type "${contentType}". Upload JPEG/PNG/WEBP/GIF or MP4/WEBM/MOV.` })
      }
      const category = body.category || 'other'
      if (!ALLOWED_CATEGORIES.has(category)) return res.status(400).json({ error: 'invalid category' })

      const ext = extFromContentType(contentType)
      const path = `${profileId}/${category}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
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
        media_type: isVideo ? 'video' : 'image',
        category,
      })
    }

    // ── FINALIZE: insert row + (images) vision analysis ─────────────
    if (mode === 'finalize') {
      const path = body.path
      if (!path) return res.status(400).json({ error: 'path required' })
      if (!path.startsWith(`${profileId}/`)) {
        return res.status(400).json({ error: 'path does not belong to this profile' })
      }
      let category = body.category || 'other'
      if (!ALLOWED_CATEGORIES.has(category)) return res.status(400).json({ error: 'invalid category' })
      const mediaType = body.media_type === 'video' ? 'video' : 'image'
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`

      // Vision analysis for images. Runs inline (single Claude call).
      // Video analysis is deferred to a later phase (thumbnail-based).
      let visionJson = null
      let label = body.label ? String(body.label).slice(0, 120) : null
      if (mediaType === 'image') {
        const brandCtx = await loadBrandContext(profileId).catch(() => null)
        const brandMd = brandCtx ? renderBrandContextMarkdown(brandCtx) : ''
        visionJson = await analyzeImage(publicUrl, brandMd)
        if (visionJson) {
          if (!label && visionJson.label) label = String(visionJson.label).slice(0, 120)
          // Let the model's category suggestion win only when the user
          // left it at the default 'other'.
          if (category === 'other' && ALLOWED_CATEGORIES.has(visionJson.category)) {
            category = visionJson.category
          }
        }
      }

      const inserted = await supaFetch('brand_assets', {
        method: 'POST',
        body: {
          profile_id: profileId,
          media_type: mediaType,
          category,
          storage_path: path,
          public_url: publicUrl,
          label,
          vision_json: visionJson,
          width_px: Number.isFinite(body.width_px) ? body.width_px : null,
          height_px: Number.isFinite(body.height_px) ? body.height_px : null,
        },
      })
      const row = Array.isArray(inserted) ? inserted[0] : inserted
      return res.status(201).json({ asset: row })
    }

    return res.status(400).json({ error: `Unknown mode "${mode}". Use init or finalize.` })
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || String(e) })
  }
}
