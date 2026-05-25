// POST /api/studio/enrich-overlays { studio_video_id }
//
// Non-destructive enrichment pass. Loads the existing script + segments,
// asks Claude to emit overlay_placements for each speaker segment, and
// PATCHes ONLY the overlay_placements column.
//
// What it touches:
//   - studio_segments.overlay_placements  (overwritten with new array)
//
// What it never touches:
//   - voice_url, image_url, avatar_video_url
//   - script_text, hyperframes_composition_id, hyperframes_variables
//   - status, approved, transition_in, sound_effect
//   - studio_videos columns (template_id, brand_color, etc.)
//
// User experience:
//   1. User has a rendered video with no overlays (or wants different ones).
//   2. Clicks "Add overlays + captions" in the editor.
//   3. Endpoint runs ~3-5s — same cost as a normal Claude tool call.
//   4. Segments now carry overlay_placements; re-clicking Render bakes
//      them into the existing video without any asset regen.
//
// Concretely solves: KJN avatar videos are saved in storage; we
// shouldn't re-spend HeyGen credits just to enrich the visual layer.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { gateStudio } from './_lib/gate.js'
import { message as anthropicMessage } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'
import { resolveTemplate } from './_lib/templates.js'
import { OVERLAY_DEFINITIONS, ALL_ZONES, isValidZoneForOrientation } from './_lib/overlay-definitions.js'

const CAPTION_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'so', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'i', 'you', 'we', 'they', 'he', 'she', 'it', 'me', 'us', 'them', 'him', 'her',
  'my', 'your', 'our', 'their', 'his', 'her', 'its',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'as', 'by', 'from', 'into', 'about',
  'this', 'that', 'these', 'those', 'there', 'here', 'where', 'when', 'what', 'which', 'who',
  'do', 'did', 'does', 'has', 'have', 'had', 'will', 'would', 'should', 'could', 'can',
  'just', 'like', 'than', 'then', 'one', 'all', 'not', 'only', 'really', 'very',
])
function pickCaptionHighlight(text) {
  if (!text) return null
  const candidates = String(text).split(/\s+/)
    .map((t) => t.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ''))
    .filter((t) => t.length >= 3 && !CAPTION_STOPWORDS.has(t.toLowerCase()))
  if (!candidates.length) return null
  return candidates.sort((a, b) => {
    const aCaps = a === a.toUpperCase() && /[A-Z]/.test(a) ? 1 : 0
    const bCaps = b === b.toUpperCase() && /[A-Z]/.test(b) ? 1 : 0
    if (aCaps !== bCaps) return bCaps - aCaps
    const aNum = /\d/.test(a) ? 1 : 0
    const bNum = /\d/.test(b) ? 1 : 0
    if (aNum !== bNum) return bNum - aNum
    return b.length - a.length
  })[0]
}

// Tight tool schema — Claude only emits overlay placements, indexed by
// segment_id so we can match without trusting order.
const ENRICH_TOOL = {
  name: 'enrich_segments',
  description: 'For each speaker segment, emit the overlay placements that reinforce the spoken content.',
  input_schema: {
    type: 'object',
    required: ['enrichments'],
    properties: {
      enrichments: {
        type: 'array',
        items: {
          type: 'object',
          required: ['segment_id', 'overlay_placements'],
          properties: {
            segment_id: { type: 'string', description: 'Existing studio_segments.id this enrichment targets.' },
            overlay_placements: {
              type: 'array',
              maxItems: 3,  // captions get auto-added server-side; non-caption cap is 2
              items: {
                type: 'object',
                required: ['overlay_id', 'zone', 'content'],
                properties: {
                  overlay_id: { type: 'string', enum: Object.keys(OVERLAY_DEFINITIONS) },
                  zone: { type: 'string', enum: [...ALL_ZONES] },
                  content: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
      },
    },
  },
}

function buildSystem(brandMd, tmpl, captionsOn) {
  const pool = tmpl.overlay_pool || []
  const overlayList = pool.length ? pool.map((id) => {
    const def = OVERLAY_DEFINITIONS[id]
    return def ? `  - ${id}: ${def.description} Allowed zones: ${def.allowed_zones.join(', ')}.` : null
  }).filter(Boolean).join('\n') : '  (template has no overlay pool — return empty arrays)'

  return `You are Studio's overlay-enrichment pass. The video has already been segmented and rendered with avatar + B-roll + voice. Your job is to add visual overlay cards that reinforce what the avatar is saying — without changing the script, audio, or any other rendered asset.

Overlay cards available for this template:
${overlayList}

Rules (READ CAREFULLY):
- Only emit overlays for segments where segment_type is "avatar" or "voiceover_broll". Skip motion-graphics segments entirely (return an empty array for them).
- Cap at 2 NON-caption overlays per segment. Most segments need 0-1.
- A stat the avatar speaks ("10x", "47K", "$2M") → stat-callout-v1 in right_overlay with the exact number + unit.
- A specific company / tool / brand the avatar names ("HeyGen", "Claude", "Notion", "Shopify", "OpenAI") → tool-logo-v1 with logo glyph = first letter capital, name = full company name. Place in right_overlay.
- A cited source ("according to Forbes") → source-citation-v1 in left_overlay paired with the stat.
- A section / chapter beat → chapter-marker-v1 in left_overlay (or top-strip for vertical). meta = section label, title = 2-4 word section name.
- A direct CTA ("save this", "follow", "subscribe") → action-prompt-v1 in right_overlay.
- watermark-v1 (@handle) on the FIRST speaker segment in corner-tr.
- Center column is reserved for the avatar — never target it.
${captionsOn ? `
Captions: ON for this video. The server auto-inserts caption-overlay-v1 on every speaker segment after your response — DO NOT emit caption-overlay-v1 yourself. Focus on the visual overlays only.
` : `
Captions: OFF.
`}
${brandMd ? `Brand context:\n${brandMd}\n` : ''}

Output exactly one tool call. Every segment must appear in the enrichments array, even if you return an empty overlay_placements list for motion-graphics segments. Use the EXACT segment_id strings from the input.`
}

function buildUser(segments) {
  // Compact JSON the LLM consumes. We strip everything that doesn't
  // matter for overlay decisions (URLs, status, asset metadata).
  const compact = segments.map((s) => ({
    segment_id: s.id,
    index: s.segment_index,
    type: s.segment_type,
    script: s.script_text || null,
    composition: s.hyperframes_composition_id || null,
  }))
  return `Existing segments:\n\`\`\`json\n${JSON.stringify(compact, null, 2)}\n\`\`\`\n\nEmit one tool call to enrich_segments with overlay_placements for each entry.`
}

function extractToolInput(claudeBody) {
  if (!claudeBody?.content) return null
  for (const block of claudeBody.content) {
    if (block.type === 'tool_use' && block.name === 'enrich_segments') return block.input
  }
  return null
}

// Same filter logic as generate-map's sanitizeOverlayPlacements.
function filterPlacements(raw, tmpl, orientation) {
  if (!Array.isArray(raw) || !raw.length) return []
  const pool = new Set(tmpl?.overlay_pool || [])
  const out = []
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue
    if (!OVERLAY_DEFINITIONS[p.overlay_id]) continue
    if (pool.size && !pool.has(p.overlay_id)) continue
    if (p.overlay_id === 'caption-overlay-v1') continue  // server auto-adds these
    const def = OVERLAY_DEFINITIONS[p.overlay_id]
    const zone = typeof p.zone === 'string' ? p.zone : def.default_zone
    if (!ALL_ZONES.has(zone)) continue
    if (!def.allowed_zones.includes(zone)) continue
    if (!isValidZoneForOrientation(zone, orientation)) continue
    out.push({
      overlay_id: p.overlay_id,
      zone,
      content: (p.content && typeof p.content === 'object') ? p.content : {},
    })
    if (out.length >= 2) break
  }
  return out
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    gateStudio(auth.user.id)
    const videoId = req.body?.studio_video_id
    if (!videoId) return res.status(400).json({ error: 'studio_video_id required' })

    const vRows = await supaFetch(`studio_videos?id=eq.${videoId}&select=*&limit=1`)
    const video = vRows?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    const segments = await supaFetch(
      `studio_segments?studio_video_id=eq.${videoId}&select=id,segment_index,segment_type,script_text,hyperframes_composition_id&order=segment_index.asc&limit=200`,
    )
    if (!segments?.length) return res.status(400).json({ error: 'No segments to enrich' })

    const tmpl = resolveTemplate(video.template_id || 'sleek', video.brand_color, video.brand_color_secondary)
    const orientation = video.aspect_ratio === '9:16' ? 'vertical' : 'landscape'
    const captionsOn = video.captions_enabled !== false

    let brandMd = ''
    try {
      const ctx = await loadBrandContext(video.profile_id)
      brandMd = renderBrandContextMarkdown(ctx, { exclude: ['exemplars'] })
    } catch { /* optional */ }

    let claudeResp
    try {
      claudeResp = await anthropicMessage({
        system: buildSystem(brandMd, tmpl, captionsOn),
        messages: [{ role: 'user', content: buildUser(segments) }],
        tools: [ENRICH_TOOL],
        tool_choice: { type: 'tool', name: 'enrich_segments' },
        max_tokens: 6000,
      })
    } catch (apiErr) {
      // Anthropic-side failure (rate limit, model error, network blip).
      // Wrap so the client gets a clean JSON body instead of a Vercel
      // HTML error page → "Invalid JSON" toast.
      const msg = apiErr?.message || String(apiErr)
      return res.status(502).json({ error: `Claude API error: ${msg.slice(0, 500)}` })
    }
    const input = extractToolInput(claudeResp)
    if (!input?.enrichments) {
      // Dump a small sample of what Claude returned so the next user
      // report is debuggable instead of "Invalid JSON."
      const sample = JSON.stringify(claudeResp).slice(0, 500)
      return res.status(502).json({ error: `Claude did not return an enrichment plan. Response sample: ${sample}` })
    }

    // Index Claude's enrichments by segment_id for lookup.
    const byId = new Map()
    for (const e of input.enrichments) {
      if (e?.segment_id) byId.set(e.segment_id, e.overlay_placements || [])
    }

    // For each segment, build the final placements array.
    let updated = 0
    let captionsInjected = 0
    let visualOverlays = 0
    const captionPoolOk = !tmpl.overlay_pool?.length || tmpl.overlay_pool.includes('caption-overlay-v1')

    for (const seg of segments) {
      // Visual overlays (stat-callout, tool-logo, etc.) only ride
      // speaker footage — avatar + voiceover_broll. Captions ride
      // every voiceover segment for accessibility, including
      // voiceover_motion_graphics. pure_motion_graphics has no script
      // and no voice so gets nothing.
      const speaker = seg.segment_type === 'avatar' || seg.segment_type === 'voiceover_broll'
      const hasVoice = speaker || seg.segment_type === 'voiceover_motion_graphics'
      if (!hasVoice) {
        // Wipe any stale overlays on pure_motion_graphics rows.
        await supaFetch(`studio_segments?id=eq.${seg.id}`, {
          method: 'PATCH', body: { overlay_placements: [] }, prefer: 'return=minimal',
        })
        continue
      }
      const visual = speaker ? filterPlacements(byId.get(seg.id), tmpl, orientation) : []
      visualOverlays += visual.length

      const placements = [...visual]
      if (captionsOn && captionPoolOk && seg.script_text?.trim()) {
        const highlight = pickCaptionHighlight(seg.script_text)
        placements.push({
          overlay_id: 'caption-overlay-v1',
          zone: 'lower-third',
          content: highlight ? { text: seg.script_text.trim(), highlight } : { text: seg.script_text.trim() },
        })
        captionsInjected++
      }

      await supaFetch(`studio_segments?id=eq.${seg.id}`, {
        method: 'PATCH',
        body: { overlay_placements: placements },
        prefer: 'return=minimal',
      })
      updated++
    }

    return res.status(200).json({
      ok: true,
      segments_updated: updated,
      visual_overlays_added: visualOverlays,
      captions_injected: captionsInjected,
      captions_enabled: captionsOn,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || String(err) })
  }
}
