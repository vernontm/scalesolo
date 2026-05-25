// POST /api/studio/refresh-motion-graphics { studio_video_id }
//
// Non-destructive Claude pass that re-picks the BEST composition_id +
// fills the hyperframes_variables for every motion-graphics segment
// based on its actual script_text. Solves the common bug where the
// original segmentation pass picked stat-reveal-v1 with stat_number
// "10" on a sentence that says nothing about a number.
//
// What it touches:
//   - studio_segments.hyperframes_composition_id  (may change)
//   - studio_segments.hyperframes_variables        (overwritten)
//
// What it never touches:
//   - voice_url, image_url, avatar_video_url, script_text,
//     segment_type, overlay_placements, transition_in, sound_effect,
//     status, approved.
//
// Only runs on segments with segment_type in
// (voiceover_motion_graphics, pure_motion_graphics). Avatar / B-roll
// segments are no-ops.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { gateStudio } from './_lib/gate.js'
import { message as anthropicMessage } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'
import { resolveTemplate } from './_lib/templates.js'

// Schema Claude sees. Indexed by segment_id so we don't rely on order.
const REFRESH_TOOL = {
  name: 'refresh_motion_segments',
  description: 'For each motion-graphics segment, pick the best composition from the template pool and fill its variables to match the spoken content.',
  input_schema: {
    type: 'object',
    required: ['refreshes'],
    properties: {
      refreshes: {
        type: 'array',
        items: {
          type: 'object',
          required: ['segment_id', 'composition_id', 'variables'],
          properties: {
            segment_id: { type: 'string' },
            composition_id: {
              type: 'string',
              description: 'Must be in the template composition_pool you were given.',
            },
            variables: {
              type: 'object',
              description: 'Slot values for the chosen composition. Common keys: title, subtitle, accent_color, stat_number, stat_label, bullets (array of strings — length MUST match the actual count of items in the script), quote, attribution.',
              additionalProperties: true,
            },
          },
        },
      },
    },
  },
}

function buildSystem(brandMd, tmpl) {
  const pool = tmpl.composition_pool || []
  return `You are Studio's motion-graphics refresher. Each segment already has a script and is rendering as motion graphics. Your job is to look at the actual SCRIPT TEXT of each segment and pick the composition + variables that ACCURATELY match what's being said.

Composition pool (you may ONLY pick from this list — Sleek v2):
${pool.map((id) => `  - ${id}`).join('\n')}

How to pick (only 3 options — choose by content shape):

- sleek-scene-headline-v1: ANY "big text on screen" moment — titles,
  quotes, stat reveals, single-line punchlines. The composition shows
  one headline split into two pieces:
    title_chrome  — the lead-in (white chrome gradient)
    title_accent  — the punchy word / number / brand name (red glow)
  Examples:
    "We grew 10x"            → chrome "We grew",        accent "10x"
    "The future is one person" → chrome "The future is", accent "one person"
    "Here's the thing"       → chrome "Here's",         accent "the thing"
  Optional vars: subtitle (one line under), eyebrow (small red label above).
  This is the DEFAULT pick — use it when nothing else fits.

- sleek-scene-list-v1: ONLY when the script enumerates 3-5 discrete
  items. Set:
    list_title_chrome / list_title_accent — same chrome+accent pair
    items — JSON ARRAY STRING of {text, highlight?}, max 5
  items array length MUST match the literal count of items mentioned.
  Example: "voice, video, and image generation" → exactly 3 entries.

- sleek-scene-claude-chat-v1: ONLY when the script explicitly mentions
  asking/prompting/telling Claude something. Shows a Claude.ai-style
  chat UI with the user's prompt and Claude's reply typing
  word-by-word. Slots:
    user_message    — quote the prompt VERBATIM from script, stripping
                      "I told Claude" framing. e.g. script "I told
                      Claude to build me a React CRM" → user_message
                      "Build me a React CRM."
    claude_response — what Claude said back. If the script states it,
                      use that verbatim; otherwise write a short 2-3
                      sentence on-brand reply in Claude voice.
  Don't pick this for generic "AI did X" — needs explicit Claude.

- sleek-scene-cta-v1: ONLY the LAST motion-graphics segment of the
  video. Sets:
    cta_headline_chrome / cta_headline_accent
    cta_subhead — one-line description
    cta_button_text — button label
    hero_handle — defaults to the brand handle
    eyebrow — optional small red label above headline

Per-variable accuracy rules:
- Pull text VERBATIM from the script where you can. Don't fabricate
  numbers, brand names, or stats that the script doesn't say.
- title_accent / list_title_accent / cta_headline_accent is for the
  punchy word — pick ONE word or short phrase. Everything else goes
  in chrome.
- accent_color: "${tmpl.colors.primary_accent}"
- handle / hero_handle defaults to the user's brand handle if you
  don't know it; otherwise pull from the brand context below.

${brandMd ? `Brand context (use voice/tone in any new copy you generate):\n${brandMd}\n` : ''}

Output one tool call. Every motion-graphics segment_id you were given MUST appear in the refreshes array.`
}

function buildUser(motionSegments) {
  const compact = motionSegments.map((s) => ({
    segment_id: s.id,
    index: s.segment_index,
    script: s.script_text || null,
    current_composition: s.hyperframes_composition_id || null,
    current_variables: s.hyperframes_variables || {},
  }))
  return `Motion-graphics segments to refresh:\n\`\`\`json\n${JSON.stringify(compact, null, 2)}\n\`\`\`\n\nFor each segment_id, emit the best (composition_id, variables) pair for its actual script content. Call refresh_motion_segments exactly once.`
}

function extractToolInput(claudeBody) {
  if (!claudeBody?.content) return null
  for (const block of claudeBody.content) {
    if (block.type === 'tool_use' && block.name === 'refresh_motion_segments') return block.input
  }
  return null
}

function sanitize(refresh, pool) {
  if (!refresh || typeof refresh !== 'object') return null
  if (!refresh.segment_id) return null
  const compId = pool.includes(refresh.composition_id) ? refresh.composition_id : null
  if (!compId) return null
  const vars = (refresh.variables && typeof refresh.variables === 'object') ? refresh.variables : {}
  return { segment_id: refresh.segment_id, composition_id: compId, variables: vars }
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

    const allSegments = await supaFetch(
      `studio_segments?studio_video_id=eq.${videoId}&select=id,segment_index,segment_type,script_text,hyperframes_composition_id,hyperframes_variables&order=segment_index.asc&limit=200`,
    )
    if (!allSegments?.length) return res.status(400).json({ error: 'No segments to refresh' })

    const motionSegments = allSegments.filter((s) =>
      s.segment_type === 'voiceover_motion_graphics' || s.segment_type === 'pure_motion_graphics'
    )
    if (!motionSegments.length) {
      return res.status(200).json({ ok: true, refreshed: 0, note: 'No motion-graphics segments to refresh.' })
    }

    const tmpl = resolveTemplate(video.template_id || 'sleek', video.brand_color)
    const pool = tmpl.composition_pool || []

    let brandMd = ''
    try {
      const ctx = await loadBrandContext(video.profile_id)
      brandMd = renderBrandContextMarkdown(ctx, { exclude: ['exemplars'] })
    } catch { /* optional */ }

    let claudeResp
    try {
      claudeResp = await anthropicMessage({
        system: buildSystem(brandMd, tmpl),
        messages: [{ role: 'user', content: buildUser(motionSegments) }],
        tools: [REFRESH_TOOL],
        tool_choice: { type: 'tool', name: 'refresh_motion_segments' },
        max_tokens: 6000,
      })
    } catch (apiErr) {
      const msg = apiErr?.message || String(apiErr)
      return res.status(502).json({ error: `Claude API error: ${msg.slice(0, 500)}` })
    }
    const input = extractToolInput(claudeResp)
    if (!input?.refreshes) {
      return res.status(502).json({
        error: `Claude did not return a refresh plan. Sample: ${JSON.stringify(claudeResp).slice(0, 400)}`,
      })
    }

    const byId = new Map()
    for (const r of input.refreshes) {
      const clean = sanitize(r, pool)
      if (clean) byId.set(clean.segment_id, clean)
    }

    let refreshed = 0
    const compChanges = []
    for (const seg of motionSegments) {
      const plan = byId.get(seg.id)
      if (!plan) continue
      const changedComp = plan.composition_id !== seg.hyperframes_composition_id
      await supaFetch(`studio_segments?id=eq.${seg.id}`, {
        method: 'PATCH',
        body: {
          hyperframes_composition_id: plan.composition_id,
          hyperframes_variables: plan.variables,
          // Reset to pending so the UI shows the row as needing a fresh
          // render — voice/audio are still valid (we didn't touch those).
          status: 'ready',
        },
        prefer: 'return=minimal',
      })
      if (changedComp) compChanges.push({ seg: seg.segment_index, from: seg.hyperframes_composition_id, to: plan.composition_id })
      refreshed++
    }

    return res.status(200).json({
      ok: true,
      motion_segments_total: motionSegments.length,
      refreshed,
      composition_changes: compChanges,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || String(err) })
  }
}
