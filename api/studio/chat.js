// POST /api/studio/chat — surgical-edit chat agent for Studio video maps.
//
// Body: { studio_video_id, message, history? }
//   - studio_video_id: parent video to operate on
//   - message: user's natural-language request ("swap segment 4 B-roll to a
//     beach sunset", "make all title cards use accent red")
//   - history: optional prior turns [{ role, content }] for context
//
// Returns:
//   { assistant_message, applied_ops: [...] }
//
// Architecture: Claude sees the structured video map (parent + segments)
// and decides which structured operations to call. We expose a small set
// of tools (patch_segment, delete_segment, insert_segment, swap_composition)
// that map cleanly to existing studio_segments mutations. Claude calls
// them via tool_use; we execute server-side; the UI sees the updates
// stream in via the same Realtime channel the editor already uses.
//
// Constraints:
//   - Operations on segments are bounded (max 50 per call) so a runaway
//     LLM can't nuke an entire video map in one shot.
//   - All mutations honor the existing RLS via supaFetch.
//   - The chat doesn't fire asset regen or final-bake on its own — it
//     just edits the map. User clicks Render afterwards.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { gateStudio } from './_lib/gate.js'
import { message as anthropicMessage } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'
import { resolveTemplate } from './_lib/templates.js'
import { OVERLAY_DEFINITIONS, ALL_ZONES, isValidZoneForOrientation } from './_lib/overlay-definitions.js'

// Mirror the allowlists in generate-map.js so the chat can't pick a
// composition_id / transition the renderer doesn't honor.
const HF_COMPOSITION_IDS = [
  // Sleek + Atlas pools — eight compositions total. Each template's
  // composition_pool field gates which ones Claude can pick for a
  // given video; this allowlist is the union for downstream validation.
  'sleek-scene-headline-v1', 'sleek-scene-list-v1',
  'sleek-scene-claude-chat-v1', 'sleek-scene-cta-v1',
  'atlas-scene-headline-v1', 'atlas-scene-list-v1',
  'atlas-scene-claude-chat-v1', 'atlas-scene-cta-v1',
]
const SEGMENT_TYPES = [
  'avatar', 'voiceover_broll', 'voiceover_motion_graphics', 'pure_motion_graphics',
]
const TRANSITIONS = ['cut', 'fade', 'crossfade', 'whip', 'zoom', 'wipe', 'dip_to_black']
const SFX_LIBRARY = ['swoosh', 'whoosh', 'ding', 'pop', 'click', 'impact', 'subtle_chime']

const MAX_OPS_PER_TURN = 50

// Tool definitions Claude sees. Schemas mirror the studio_segments table
// shape so Claude can't propose mutations the DB constraints would reject.
const TOOLS = [
  {
    name: 'patch_segment',
    description: 'Mutate one or more fields on an existing segment. Use this for narrow edits like changing script text, image prompt, motion gesture, sound effect, transition, hyperframes composition id, or hyperframes variables.',
    input_schema: {
      type: 'object',
      required: ['segment_id', 'patch'],
      properties: {
        segment_id: { type: 'string', description: 'The studio_segments.id of the row to update.' },
        patch: {
          type: 'object',
          description: 'Fields to update. Only listed fields are modified; everything else is preserved. Pass null to clear a field. Resets the row\'s status to "pending" if script_text / image_prompt / hyperframes_* changed, since the existing assets are no longer in sync.',
          properties: {
            script_text:          { type: ['string','null'] },
            image_prompt:         { type: ['string','null'] },
            motion_gesture_prompt:{ type: ['string','null'] },
            hyperframes_composition_id: { type: ['string','null'], enum: [...HF_COMPOSITION_IDS, null] },
            hyperframes_variables:{ type: ['object','null'] },
            transition_in:        { type: 'string', enum: TRANSITIONS },
            sound_effect:         { type: ['string','null'], enum: [...SFX_LIBRARY, null] },
            segment_type:         { type: 'string', enum: SEGMENT_TYPES },
            approved:             { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
  },
  {
    name: 'delete_segment',
    description: 'Remove a segment entirely. Use when the user asks to "drop", "remove", or "delete" a row.',
    input_schema: {
      type: 'object',
      required: ['segment_id'],
      properties: {
        segment_id: { type: 'string' },
      },
    },
  },
  {
    name: 'insert_segment',
    description: 'Insert a new segment after an existing one. The new row gets segment_index = insertion point and every following row is shifted +1.',
    input_schema: {
      type: 'object',
      required: ['after_segment_id', 'segment'],
      properties: {
        after_segment_id: { type: 'string', description: 'Insert immediately after this segment. Pass empty string "" to insert at index 0.' },
        segment: {
          type: 'object',
          required: ['segment_type'],
          properties: {
            segment_type:         { type: 'string', enum: SEGMENT_TYPES },
            script_text:          { type: ['string','null'] },
            image_prompt:         { type: ['string','null'] },
            motion_gesture_prompt:{ type: ['string','null'] },
            hyperframes_composition_id: { type: ['string','null'], enum: [...HF_COMPOSITION_IDS, null] },
            hyperframes_variables:{ type: ['object','null'] },
            transition_in:        { type: 'string', enum: TRANSITIONS },
            sound_effect:         { type: ['string','null'], enum: [...SFX_LIBRARY, null] },
            approved:             { type: 'boolean' },
          },
        },
      },
    },
  },
  {
    name: 'place_overlay',
    description: 'Add an overlay card to an avatar or voiceover_broll segment. Overlays ride on top of speaker footage in defined zones — never use them on motion-graphics segments. Pass replace=true to clear existing overlays on the segment first; default appends.',
    input_schema: {
      type: 'object',
      required: ['segment_id', 'placement'],
      properties: {
        segment_id: { type: 'string' },
        replace:    { type: 'boolean', description: 'When true, clears the segment\'s existing overlays before adding this one. Default false (append).' },
        placement: {
          type: 'object',
          required: ['overlay_id', 'zone', 'content'],
          properties: {
            overlay_id: { type: 'string', enum: Object.keys(OVERLAY_DEFINITIONS) },
            zone:       { type: 'string', enum: [...ALL_ZONES] },
            content:    { type: 'object', additionalProperties: true, description: 'Shape varies per overlay_id. See overlay-definitions.js for required fields.' },
            start_offset_secs: { type: 'number', minimum: 0, maximum: 60 },
            duration_secs:     { type: 'number', minimum: 0.3, maximum: 60 },
          },
        },
      },
    },
  },
  {
    name: 'remove_overlay',
    description: 'Remove overlays from a segment. Pass overlay_id to remove all instances of one type; pass index to remove the Nth placement (0-indexed); omit both to clear all overlays on the segment.',
    input_schema: {
      type: 'object',
      required: ['segment_id'],
      properties: {
        segment_id: { type: 'string' },
        overlay_id: { type: 'string', enum: Object.keys(OVERLAY_DEFINITIONS) },
        index:      { type: 'integer', minimum: 0 },
      },
    },
  },
  {
    name: 'swap_composition',
    description: 'Replace a motion-graphics segment\'s HyperFrames composition + variables in one shot. Shortcut for "make this title card a quote card instead" — sets composition id, replaces variables wholesale.',
    input_schema: {
      type: 'object',
      required: ['segment_id', 'composition_id', 'variables'],
      properties: {
        segment_id:     { type: 'string' },
        composition_id: { type: 'string', enum: HF_COMPOSITION_IDS },
        variables:      { type: 'object' },
      },
    },
  },
]

// Compact JSON the LLM sees. We drop generated-asset URLs (voice_url,
// image_url, avatar_video_url) since the LLM has no business hot-linking
// them in edits — they'd be replaced by the next asset regen anyway.
function renderMapForLLM(video, segments) {
  return JSON.stringify({
    video: {
      id: video.id,
      title: video.title,
      topic_prompt: video.topic_prompt,
      aspect_ratio: video.aspect_ratio,
      target_duration_secs: video.target_duration_secs,
      status: video.status,
    },
    segments: segments.map((s) => ({
      id: s.id,
      index: s.segment_index,
      type: s.segment_type,
      approved: s.approved,
      script: s.script_text,
      image_prompt: s.image_prompt || null,
      motion_gesture: s.motion_gesture_prompt || null,
      composition: s.hyperframes_composition_id || null,
      variables: s.hyperframes_variables || {},
      transition: s.transition_in,
      sfx: s.sound_effect,
      overlays: Array.isArray(s.overlay_placements) ? s.overlay_placements : [],
      status: s.status,
    })),
  }, null, 2)
}

// ── Tool executors ──────────────────────────────────────────────────────────

async function execPatchSegment(input, ctx) {
  const id = input?.segment_id
  const patch = input?.patch || {}
  if (!id) throw new Error('patch_segment: segment_id required')
  const seg = ctx.segById.get(id)
  if (!seg) throw new Error(`patch_segment: segment ${id} not found in this video`)

  // Whitelist fields. Anything outside this set is silently dropped.
  const FIELDS = new Set([
    'script_text', 'image_prompt', 'motion_gesture_prompt',
    'hyperframes_composition_id', 'hyperframes_variables',
    'transition_in', 'sound_effect', 'segment_type', 'approved',
  ])
  const body = {}
  for (const [k, v] of Object.entries(patch)) {
    if (!FIELDS.has(k)) continue
    body[k] = v
  }

  // If anything that would invalidate the generated assets changed,
  // reset status → pending so the user sees "needs regen" on the row.
  // We don't actually wipe the asset URLs here — the renderer / asset
  // regen handles that, and keeping them around lets the user revert
  // by editing the field back to its previous value.
  const invalidatingKeys = ['script_text', 'image_prompt', 'segment_type', 'hyperframes_composition_id', 'hyperframes_variables']
  const invalidates = invalidatingKeys.some((k) => k in body && body[k] !== seg[k])
  if (invalidates) body.status = 'pending'

  await supaFetch(`studio_segments?id=eq.${id}`, {
    method: 'PATCH', body, prefer: 'return=minimal',
  })
  return { kind: 'patch_segment', segment_id: id, changed: Object.keys(body) }
}

async function execDeleteSegment(input, ctx) {
  const id = input?.segment_id
  if (!id) throw new Error('delete_segment: segment_id required')
  if (!ctx.segById.has(id)) throw new Error(`delete_segment: segment ${id} not found in this video`)
  await supaFetch(`studio_segments?id=eq.${id}`, {
    method: 'DELETE', prefer: 'return=minimal',
  })
  return { kind: 'delete_segment', segment_id: id }
}

async function execInsertSegment(input, ctx) {
  const afterId = input?.after_segment_id
  const seg = input?.segment || {}
  // Resolve insertion index. Empty after_id → insert at 0.
  let insertIdx = 0
  if (afterId) {
    const anchor = ctx.segById.get(afterId)
    if (!anchor) throw new Error(`insert_segment: after_segment_id ${afterId} not found`)
    insertIdx = anchor.segment_index + 1
  }
  // Shift every existing row at or after insertIdx by +1. Done in
  // descending order so the unique (video_id, segment_index) constraint
  // doesn't trip. The constraint is DEFERRABLE so we could batch, but
  // explicit-descending is simpler and harder to get wrong.
  const shiftRows = ctx.segments
    .filter((s) => s.segment_index >= insertIdx)
    .sort((a, b) => b.segment_index - a.segment_index)
  for (const s of shiftRows) {
    await supaFetch(`studio_segments?id=eq.${s.id}`, {
      method: 'PATCH',
      body: { segment_index: s.segment_index + 1 },
      prefer: 'return=minimal',
    })
  }
  // Build the new row honoring the same field whitelist as insert.
  const newRow = {
    studio_video_id: ctx.video.id,
    profile_id: ctx.video.profile_id,
    segment_index: insertIdx,
    segment_type: SEGMENT_TYPES.includes(seg.segment_type) ? seg.segment_type : 'voiceover_broll',
    script_text: seg.script_text ?? null,
    image_prompt: seg.image_prompt ?? null,
    motion_gesture_prompt: seg.motion_gesture_prompt ?? null,
    hyperframes_composition_id: HF_COMPOSITION_IDS.includes(seg.hyperframes_composition_id) ? seg.hyperframes_composition_id : null,
    hyperframes_variables: (seg.hyperframes_variables && typeof seg.hyperframes_variables === 'object') ? seg.hyperframes_variables : {},
    transition_in: TRANSITIONS.includes(seg.transition_in) ? seg.transition_in : 'cut',
    sound_effect: SFX_LIBRARY.includes(seg.sound_effect) ? seg.sound_effect : null,
    approved: seg.approved !== false,  // default to true to match generate-map
    status: 'pending',
  }
  const created = await supaFetch('studio_segments', {
    method: 'POST', body: [newRow], prefer: 'return=representation',
  })
  return { kind: 'insert_segment', segment_id: Array.isArray(created) ? created[0]?.id : null, at_index: insertIdx }
}

async function execSwapComposition(input, ctx) {
  const id = input?.segment_id
  const compId = input?.composition_id
  const vars = input?.variables || {}
  if (!id) throw new Error('swap_composition: segment_id required')
  if (!HF_COMPOSITION_IDS.includes(compId)) throw new Error(`swap_composition: composition_id must be one of ${HF_COMPOSITION_IDS.join(', ')}`)
  if (!ctx.segById.has(id)) throw new Error(`swap_composition: segment ${id} not found`)
  await supaFetch(`studio_segments?id=eq.${id}`, {
    method: 'PATCH',
    body: {
      hyperframes_composition_id: compId,
      hyperframes_variables: vars,
      // Force the row into voiceover_motion_graphics if it isn't motion
      // already — composition swap only makes sense for motion segments.
      ...(ctx.segById.get(id).segment_type === 'avatar' || ctx.segById.get(id).segment_type === 'voiceover_broll'
        ? { segment_type: 'voiceover_motion_graphics' } : {}),
      status: 'pending',
    },
    prefer: 'return=minimal',
  })
  return { kind: 'swap_composition', segment_id: id, composition_id: compId }
}

// Validate a single placement against the template's overlay_pool and
// the video's orientation. Throws on the first violation — the chat
// surfaces this string back to the user, so it should be human-readable.
function validatePlacement(p, ctx) {
  if (!p || typeof p !== 'object') throw new Error('placement is required')
  const def = OVERLAY_DEFINITIONS[p.overlay_id]
  if (!def) throw new Error(`overlay_id "${p.overlay_id}" is not a known overlay`)
  if (ctx.overlayPool.size && !ctx.overlayPool.has(p.overlay_id)) {
    throw new Error(`overlay "${p.overlay_id}" is not in this template's overlay_pool`)
  }
  const zone = p.zone || def.default_zone
  if (!ALL_ZONES.has(zone)) throw new Error(`zone "${zone}" is not a valid zone`)
  if (!def.allowed_zones.includes(zone)) {
    throw new Error(`overlay "${p.overlay_id}" cannot render in zone "${zone}". Allowed: ${def.allowed_zones.join(', ')}`)
  }
  if (!isValidZoneForOrientation(zone, ctx.orientation)) {
    throw new Error(`zone "${zone}" is not valid for orientation "${ctx.orientation}"`)
  }
}

async function execPlaceOverlay(input, ctx) {
  const id = input?.segment_id
  if (!id) throw new Error('place_overlay: segment_id required')
  const seg = ctx.segById.get(id)
  if (!seg) throw new Error(`place_overlay: segment ${id} not found in this video`)
  if (seg.segment_type !== 'avatar' && seg.segment_type !== 'voiceover_broll') {
    throw new Error(`place_overlay: overlays only ride on avatar / voiceover_broll segments (this one is ${seg.segment_type}).`)
  }
  const placement = input.placement
  validatePlacement(placement, ctx)

  // Build the clean placement row — only known fields.
  const clean = {
    overlay_id: placement.overlay_id,
    zone: placement.zone || OVERLAY_DEFINITIONS[placement.overlay_id].default_zone,
    content: (placement.content && typeof placement.content === 'object') ? placement.content : {},
  }
  if (typeof placement.start_offset_secs === 'number') clean.start_offset_secs = Math.max(0, Math.min(60, placement.start_offset_secs))
  if (typeof placement.duration_secs === 'number') clean.duration_secs = Math.max(0.3, Math.min(60, placement.duration_secs))

  const existing = Array.isArray(seg.overlay_placements) ? seg.overlay_placements : []
  const next = input.replace ? [clean] : [...existing, clean]
  // Cap at 4 — same as the segmentation schema.
  const capped = next.slice(0, 4)

  await supaFetch(`studio_segments?id=eq.${id}`, {
    method: 'PATCH',
    body: { overlay_placements: capped },
    prefer: 'return=minimal',
  })
  // Mirror into ctx so subsequent ops in the same turn see the update.
  seg.overlay_placements = capped
  return { kind: 'place_overlay', segment_id: id, overlay_id: clean.overlay_id, zone: clean.zone, total: capped.length }
}

async function execRemoveOverlay(input, ctx) {
  const id = input?.segment_id
  if (!id) throw new Error('remove_overlay: segment_id required')
  const seg = ctx.segById.get(id)
  if (!seg) throw new Error(`remove_overlay: segment ${id} not found in this video`)
  const existing = Array.isArray(seg.overlay_placements) ? seg.overlay_placements : []
  let next
  if (typeof input.index === 'number') {
    next = existing.filter((_, i) => i !== input.index)
  } else if (input.overlay_id) {
    next = existing.filter((p) => p.overlay_id !== input.overlay_id)
  } else {
    next = []
  }
  await supaFetch(`studio_segments?id=eq.${id}`, {
    method: 'PATCH',
    body: { overlay_placements: next },
    prefer: 'return=minimal',
  })
  seg.overlay_placements = next
  return { kind: 'remove_overlay', segment_id: id, removed: existing.length - next.length, remaining: next.length }
}

const EXECUTORS = {
  patch_segment: execPatchSegment,
  delete_segment: execDeleteSegment,
  insert_segment: execInsertSegment,
  swap_composition: execSwapComposition,
  place_overlay: execPlaceOverlay,
  remove_overlay: execRemoveOverlay,
}

// ── System prompt ───────────────────────────────────────────────────────────

function buildSystem(brandMd, mapJson, ctx) {
  const overlayPoolBlock = ctx?.overlayPool?.size
    ? `\nOverlay cards available for this template (place via place_overlay):\n${[...ctx.overlayPool].map((id) => `  - ${id}: ${OVERLAY_DEFINITIONS[id]?.description || ''}`).join('\n')}\nOverlays only ride on avatar / voiceover_broll segments. Never place on motion-graphics segments. Center column is reserved for the avatar — never target it.\n`
    : ''
  return `You are Studio's chat editor — a surgical-edit agent for a long-form video map.

The user is iterating on a video they've already drafted. Their request will be a natural-language ask like "change segment 4's B-roll to a sunset" or "make all the motion graphics use the accent color red" or "drop segment 7." Your job is to translate that into the smallest possible set of structured tool calls that achieve the ask, then briefly summarize what you did.

Operating rules:
- Always call the appropriate tool(s) to actually make the edits. Do NOT just describe what would change.
- Use patch_segment for narrow field updates. Use swap_composition when the user wants to change a motion-graphics template wholesale. Use insert_segment / delete_segment for additions and removals.
- One tool call per logical change. A "make all X" request becomes multiple patch_segment calls.
- Stay within ${MAX_OPS_PER_TURN} operations per turn. If the user asks for something that would exceed this, do what you can and tell them what's left.
- Respect the brand voice (below) when generating new script text or image prompts.
- Don't fabricate segment ids — only use ids that appear in the video map below.
- After your tool calls, write a 1-2 sentence summary of what you changed. No long preamble.

Composition library (Sleek v2 — these exact ids):
  sleek-scene-headline-v1 — big text on screen (titles, quotes,
    single-line punchlines, stat reveals). Variables: title_chrome
    (chrome part), title_accent (red accent part), optional eyebrow
    + subtitle.
  sleek-scene-list-v1 — enumerated lists, 3-5 items. Variables:
    list_title_chrome, list_title_accent, items (JSON array string of
    {text, highlight?}, auto-numbered).
  sleek-scene-claude-chat-v1 — script mentions asking/prompting Claude.
    Shows a Claude UI with the user's prompt + Claude's reply typing
    word-by-word. Variables: user_message, claude_response.
  sleek-scene-cta-v1 — final segment CTA. Variables:
    cta_headline_chrome, cta_headline_accent, cta_subhead,
    cta_button_text, hero_handle.
${overlayPoolBlock}
${brandMd ? `Brand context:\n${brandMd}\n` : ''}

Current video map:
\`\`\`json
${mapJson}
\`\`\`
`
}

// ── Main handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    gateStudio(auth.user.id)
    const videoId = req.body?.studio_video_id
    const message = String(req.body?.message || '').trim()
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-12) : []
    if (!videoId) return res.status(400).json({ error: 'studio_video_id required' })
    if (!message) return res.status(400).json({ error: 'message required' })

    const vRows = await supaFetch(`studio_videos?id=eq.${videoId}&select=*&limit=1`)
    const video = vRows?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    const segments = await supaFetch(
      `studio_segments?studio_video_id=eq.${videoId}&select=*&order=segment_index.asc&limit=200`
    )

    let brandMd = ''
    try {
      const ctxBrand = await loadBrandContext(video.profile_id)
      brandMd = renderBrandContextMarkdown(ctxBrand, { exclude: ['exemplars'] })
    } catch { /* brand context optional */ }

    // Map id → segment for tool executor lookups. Also resolve the
    // template so overlay placements can be validated against its
    // overlay_pool, and stamp the orientation so vertical-only zones
    // get rejected in landscape videos.
    const segById = new Map(segments.map((s) => [s.id, s]))
    const tmpl = resolveTemplate(video.template_id || 'sleek', video.brand_color, video.brand_color_secondary)
    const orientation = video.aspect_ratio === '9:16' ? 'vertical' : 'landscape'
    const overlayPool = new Set(tmpl.overlay_pool || [])
    const ctx = { video, segments, segById, tmpl, orientation, overlayPool }

    // Build the message array. Prior history (if any) + the new user
    // turn. We don't replay tool_use/tool_result blocks — those were
    // stitched together within a previous turn server-side. The model
    // gets clean role/content pairs.
    const messages = history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }))
    messages.push({ role: 'user', content: message })

    // First Claude turn — gets a tool_use back (hopefully)
    const claudeResp = await anthropicMessage({
      system: buildSystem(brandMd, renderMapForLLM(video, segments), ctx),
      messages,
      tools: TOOLS,
      max_tokens: 4000,
    })

    const blocks = Array.isArray(claudeResp?.content) ? claudeResp.content : []
    const toolCalls = blocks.filter((b) => b.type === 'tool_use')
    const textBlocks = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').filter(Boolean)

    if (toolCalls.length > MAX_OPS_PER_TURN) {
      return res.status(400).json({
        error: `Claude proposed ${toolCalls.length} operations (max ${MAX_OPS_PER_TURN} per turn). Try a narrower request.`,
      })
    }

    // Execute every tool call. Failures on individual calls are
    // surfaced inline so the user can see exactly what didn't apply.
    const appliedOps = []
    const opErrors = []
    for (const call of toolCalls) {
      const fn = EXECUTORS[call.name]
      if (!fn) { opErrors.push({ name: call.name, error: 'Unknown tool' }); continue }
      try {
        const result = await fn(call.input || {}, ctx)
        appliedOps.push(result)
        // Refresh ctx.segments / segById after destructive ops so
        // subsequent ops see consistent state. Cheap: in-memory only.
        if (result.kind === 'delete_segment') {
          ctx.segments = ctx.segments.filter((s) => s.id !== result.segment_id)
          ctx.segById.delete(result.segment_id)
        }
      } catch (e) {
        opErrors.push({ name: call.name, error: e.message })
      }
    }

    const assistantMessage = textBlocks.join('\n\n') ||
      (appliedOps.length
        ? `Applied ${appliedOps.length} change${appliedOps.length === 1 ? '' : 's'}.`
        : 'I did not change anything. Could you rephrase the request?')

    return res.status(200).json({
      assistant_message: assistantMessage,
      applied_ops: appliedOps,
      errors: opErrors,
    })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
