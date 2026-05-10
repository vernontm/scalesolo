// GET /api/zapcap/templates
// Returns the caption template catalog the picker shows users. Two
// sources merged:
//   1. Live ZapCap /templates response — canonical id+name list.
//   2. public.zapcap_template_previews row — admin-curated preview
//      GIF + sort_order + active flag. Lets us show clean caption-
//      only previews instead of ZapCap's branded demo footage.
//
// Each row in the response carries a `preview_gif_url` field when
// the admin has uploaded one; the picker prefers that over the
// upstream thumbnail/video. Inactive templates (active=false) are
// filtered out so admins can hide rough/duplicate styles without
// deleting them. Cached in-memory for 5 min per warm container.

import { setCors, requireUser, supaFetch } from '../_lib/supabase.js'
import { zapcapListTemplates } from '../_lib/zapcap.js'

let _cache = null
let _cachedAt = 0
const TTL = 5 * 60 * 1000

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    if (_cache && Date.now() - _cachedAt < TTL) {
      return res.status(200).json({ templates: _cache, cached: true })
    }
    const [data, previewRows] = await Promise.all([
      zapcapListTemplates(),
      supaFetch('zapcap_template_previews?select=template_id,title,preview_gif_url,sort_order,active').catch(() => []),
    ])
    const live = Array.isArray(data) ? data : (Array.isArray(data?.templates) ? data.templates : [])
    const previewById = new Map((previewRows || []).map((r) => [r.template_id, r]))
    const merged = live
      .map((t) => {
        const id = t.id || t._id || t.templateId
        const row = id ? previewById.get(id) : null
        // active=false on the curated row hides the template from the
        // picker entirely. When the admin hasn't seen it yet, default
        // visible (sort to the bottom) — better than vanishing new
        // templates ZapCap rolls out before we sync.
        if (row && row.active === false) return null
        return {
          ...t,
          id,
          // Title override: admin curated > ZapCap.
          ...(row?.title ? { name: row.title } : {}),
          preview_gif_url: row?.preview_gif_url || null,
          sort_order: row?.sort_order ?? 999,
        }
      })
      .filter(Boolean)
      .sort((a, b) => (a.sort_order - b.sort_order) || String(a.name || '').localeCompare(String(b.name || '')))
    _cache = merged
    _cachedAt = Date.now()
    return res.status(200).json({ templates: merged })
  } catch (e) {
    console.error('zapcap/templates error:', e?.stack || e)
    return res.status(e.status || 502).json({ error: e.message, response: e.response })
  }
}
