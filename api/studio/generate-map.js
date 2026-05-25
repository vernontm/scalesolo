// /api/studio/generate-map — POST { studio_video_id }
//
// Turns a Studio video draft into a structured video map. Reads the
// brand profile context (voice, do-not-say, hooks, etc.) so the
// generated script + segments feel native to the brand instead of
// generic AI slop.
//
// Flow:
//   1. Gate + load video, verify ownership.
//   2. Flip studio_videos.status to 'mapping' so the UI can show a
//      loading state via Realtime.
//   3. Load brand context, render as markdown for Claude's system prompt.
//   4. Call Claude with structured tool_use output (more reliable than
//      free-text JSON parsing).
//   5. Wipe any existing segments (segmentation is idempotent — calling
//      it again from the UI re-rolls the map), then insert new ones.
//   6. Save the full script on the parent video, flip status to 'mapped'.
//   7. Return the video with inlined segments.
//
// If Claude fails or returns garbage, the video flips to 'failed' with
// the error stored so the UI can show "try again" and the user can
// re-run without losing their inputs.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { gateStudio } from './_lib/gate.js'
import { message as anthropicMessage } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'
import { resolveTemplate } from './_lib/templates.js'
import { OVERLAY_DEFINITIONS, ALL_ZONES, isValidZoneForOrientation } from './_lib/overlay-definitions.js'

// The composition library the segmentation pass is allowed to pick
// from. Stable ids — the actual HTML compositions ship in task #8.
// Keeping this allowlist server-side prevents Claude from hallucinating
// composition ids the renderer can't honor.
const HF_COMPOSITION_IDS = [
  // Sleek pool
  'sleek-scene-headline-v1',
  'sleek-scene-list-v1',
  'sleek-scene-claude-chat-v1',
  'sleek-scene-cta-v1',
  // Atlas pool (indigo + purple, dot-pattern background)
  'atlas-scene-headline-v1',
  'atlas-scene-list-v1',
  'atlas-scene-claude-chat-v1',
  'atlas-scene-cta-v1',
]

const SFX_LIBRARY = [
  'swoosh', 'whoosh', 'ding', 'pop', 'click', 'impact', 'subtle_chime',
]

const TRANSITIONS = ['cut', 'fade', 'crossfade', 'whip', 'zoom', 'wipe', 'dip_to_black']

const SEGMENT_TYPES = [
  'avatar',
  'voiceover_broll',
  'voiceover_motion_graphics',
  'pure_motion_graphics',
]

// Tool definition Claude sees. JSON schema'd response is far more
// reliable than asking for raw JSON in a message body.
const SEGMENT_TOOL = {
  name: 'emit_video_map',
  description: 'Emit the structured video map that drives Studio rendering. Must be called exactly once per response.',
  input_schema: {
    type: 'object',
    required: ['title', 'full_script', 'segments'],
    properties: {
      title: {
        type: 'string',
        description: 'Short title for the video, 8 words max, no emoji, no quotes.',
      },
      full_script: {
        type: 'string',
        description: 'The full narration as one paragraph. This is what gets spoken. Studio will derive segment_text from this same content — keep the two consistent.',
      },
      segments: {
        type: 'array',
        minItems: 6,
        maxItems: 60,
        items: {
          type: 'object',
          required: ['segment_type', 'transition_in'],
          properties: {
            segment_type: { type: 'string', enum: SEGMENT_TYPES },
            script_text: {
              type: 'string',
              description: 'What the avatar or voiceover says in this segment. Required unless segment_type is pure_motion_graphics. Average 5 seconds of spoken content (~12-15 words).',
            },
            image_prompt: {
              type: 'string',
              description: 'Required only for voiceover_broll. A specific, concrete image prompt (subject + action + style). 1-2 sentences. Match brand color palette when relevant.',
            },
            motion_gesture_prompt: {
              type: 'string',
              description: 'Optional. For avatar segments, direction on facial expression / hand gesture / energy. Skip if neutral talking-head.',
            },
            hyperframes_composition_id: {
              type: 'string',
              enum: HF_COMPOSITION_IDS,
              description: 'Required for voiceover_motion_graphics + pure_motion_graphics. Pick the template that best matches the moment.',
            },
            hyperframes_variables: {
              type: 'object',
              description: 'Variables for the chosen HyperFrames composition. Common keys: title, subtitle, accent_color (hex), stat_number, stat_label, bullets (array), quote, attribution, layout (enum).',
              additionalProperties: true,
            },
            transition_in: {
              type: 'string',
              enum: TRANSITIONS,
              description: 'How this segment enters from the previous one. Default to "cut" for high-energy edits, "fade" for emotional beats.',
            },
            sound_effect: {
              type: ['string', 'null'],
              enum: [...SFX_LIBRARY, null],
              description: 'Optional SFX on this segment\'s entry. Use sparingly — at most 1 in 4 segments. Null for none.',
            },
            duration_hint_secs: {
              type: 'number',
              minimum: 1,
              maximum: 20,
              description: 'How long this segment should play. Used only for pacing the LLM; the real duration comes from the generated voice audio.',
            },
            overlay_placements: {
              type: 'array',
              maxItems: 4,
              description: 'Optional overlay cards riding ON TOP of an avatar or voiceover_broll segment. Use sparingly — at most 2 overlays per segment, and only when the spoken content benefits from a visual anchor (a stat, a tool name, a chapter beat, a CTA). Never use overlays on motion-graphics segments; those are already self-contained.',
              items: {
                type: 'object',
                required: ['overlay_id', 'zone', 'content'],
                properties: {
                  overlay_id: {
                    type: 'string',
                    enum: Object.keys(OVERLAY_DEFINITIONS),
                    description: 'Which overlay card to render.',
                  },
                  zone: {
                    type: 'string',
                    enum: [...ALL_ZONES],
                    description: 'Where on the frame to place it. Side slots: l-top/l-mid/l-bot/r-top/r-mid/r-bot. lower-third for captions. top-strip is vertical-only.',
                  },
                  content: {
                    type: 'object',
                    description: 'Slot values for the chosen overlay. Shape varies: stat-callout-v1 needs { label, number, unit?, sub? }, caption-overlay-v1 needs { text, highlight? }, tool-logo-v1 needs { logo, name, desc? }, action-prompt-v1 needs { text, arrow? }, source-citation-v1 needs { label?, citation }, chapter-marker-v1 needs { meta, title }, word-emphasis-v1 needs { word }, watermark-v1 needs { handle }.',
                    additionalProperties: true,
                  },
                  start_offset_secs: { type: 'number', minimum: 0, maximum: 60 },
                  duration_secs:     { type: 'number', minimum: 0.3, maximum: 60 },
                },
              },
            },
          },
        },
      },
    },
  },
}

function buildSystem(brandMarkdown, tmpl, captionsEnabled) {
  // Template constraints get woven into the prompt so Claude segments
  // according to the chosen visual preset's pacing + composition pool +
  // SFX vibe. The resolved template already has {accent} replaced with
  // the user's brand color (or template default if not overridden).
  const pacing = tmpl.pacing || {}
  const audio = tmpl.audio || {}
  const compositionPool = tmpl.composition_pool || []
  const motionDensity = pacing.hard_cap_motion_density != null
    ? `Cap motion-graphics segments at ${Math.round(pacing.hard_cap_motion_density * 100)}% of the total. `
    : ''
  const sfxGuidance = audio.sfx_pool?.length
    ? `When you add a sound_effect to a segment, pick from this pool: ${audio.sfx_pool.join(', ')}. Density target: ${audio.sfx_density || 'medium'}.`
    : 'Use sound_effect sparingly.'

  // Overlay guidance — only fire if this template actually has an
  // overlay_pool. Some minimalist templates ship without one.
  const overlayPool = tmpl.overlay_pool || []
  const overlayGuidance = overlayPool.length ? `
Overlay cards (ON TOP of avatar / voiceover_broll segments — never on motion-graphics):
${overlayPool.map((id) => {
  const def = OVERLAY_DEFINITIONS[id]
  if (!def) return null
  return `  - ${id}: ${def.description} Allowed zones: ${def.allowed_zones.join(', ')}. Default: ${def.default_zone}.`
}).filter(Boolean).join('\n')}

Overlay rules (read the script content carefully and add overlays that REINFORCE what the avatar is saying):
- Only put overlays on avatar or voiceover_broll segments. Never on motion-graphics.
- Center column is reserved for the avatar. Never target it.
- Cap at 2 non-caption overlays per segment (captions don't count toward the cap).
- A stat the avatar speaks aloud ("we grew 10x", "47 thousand subscribers") → stat-callout-v1 in r-mid with the actual number. Always include the unit suffix if it's natural ("10" + unit "x", "47K", "$2M").
- A specific company or tool the avatar names ("HeyGen", "Claude", "Notion", "Shopify", "OpenAI", any product brand) → tool-logo-v1 with logo glyph = the company's first letter (capital). Place in r-top so it sits next to the speaker. Name field is the full company name.
- A cited statistic with a named source ("according to Forbes", "the Vernon Tech report") → stat-callout-v1 AND source-citation-v1 paired (stat in r-mid, citation in l-bot).
- A section / chapter beat — when the avatar transitions to a new idea — → chapter-marker-v1 in l-top (or top-strip if this is a vertical video). meta = "Part N / total" or the section number; title = a 2-4 word section name.
- A direct CTA the avatar speaks ("save this", "follow for more", "link in bio", "subscribe") → action-prompt-v1.
- A single punchy word worth slamming onto screen ("10X", "STOP", "WAIT") → word-emphasis-v1 in lower-third. Use at most 1 per video.
- watermark-v1 (@handle) should run on the FIRST segment only as a corner-tr placement. Skip it on later segments — the renderer handles persistence automatically when present at segment 0.
${captionsEnabled ? `
Captions (REQUIRED on this video — captions_enabled is on):
- EVERY avatar and voiceover_broll segment must include a caption-overlay-v1 placement in lower-third.
- The caption's content.text is the script_text for that segment (verbatim, no edits).
- The caption's content.highlight is ONE punchy word from that script_text — the most important word in the line. Match casing exactly to script_text so the renderer can locate and wrap it. Skip the highlight if no word truly stands out, but never skip the caption itself.
- Captions do NOT count toward the 2-overlay-per-segment cap.
- Captions are mandatory regardless of segment_type=avatar or voiceover_broll.
` : `
Captions: OFF for this video. Do not emit any caption-overlay-v1 placements.
`}` : ''

  return `You are Studio's segmentation engine. Your job: turn a topic into a long-form vertical or horizontal video, broken into segments that flow like a YouTube short-form-meets-explainer.

You will draft a full script in the brand's voice, then beat it into segments. Every segment is one of:
- avatar: the brand's AI avatar speaks this line on camera
- voiceover_broll: voiceover plays over a generated still image (B-roll)
- voiceover_motion_graphics: voiceover plays over an animated HyperFrames composition (title cards, stat reveals, lists, quotes)
- pure_motion_graphics: no voiceover, just motion graphics with optional SFX/music (transitions, section breaks, stings)

Visual template selected: "${tmpl.name}".
${tmpl.description}
${tmpl.when_to_use ? `Best for: ${tmpl.when_to_use}` : ''}

Composition pool you may use (do NOT pick anything outside this list):
${compositionPool.map((id) => `  - ${id}`).join('\n')}

Pacing for this template:
- Target average segment duration: ${pacing.segment_duration_avg_secs ?? 4.5} seconds.
- Hook segment max: ${pacing.hook_segment_max_secs ?? 2.5} seconds.
- Rhythm: ${pacing.rhythm || 'balanced'}.
- ${motionDensity}Vary segment types — never put 3 of the same type in a row.

Sound design:
- ${sfxGuidance}
${overlayGuidance}
Intro segment (HARD RULE):
- The first segment is ALWAYS segment_type: avatar. Never motion_graphics. The hook is the avatar speaking on camera.
- Pack the intro segment with overlays to keep viewers engaged: chapter-marker-v1 in l-top with meta "INTRO" and a 2-4 word title that captures the hook, PLUS one of (word-emphasis-v1 with the punchiest word in the hook OR stat-callout-v1 if the hook contains a number). Plus the watermark-v1 in corner-tr.
- Treat the intro overlays as the energy engine. The avatar carries the audio; the overlays carry the visual hook.

Choosing the right HyperFrames composition (Sleek v2 — four options, pick by content shape):

- sleek-scene-headline-v1: any "big text on screen" moment. Use for
  titles, single-line punchlines, quotes, AND stat reveals. The
  composition has two slots that render side-by-side:
    title_chrome   → the lead-in phrase (white chrome gradient)
    title_accent   → the punchy word / number / brand name (red glow)
  Examples:
    Script: "We grew 10x." → title_chrome:"We grew", title_accent:"10x"
    Script: "The future is one person with a stack." → title_chrome:"The future is", title_accent:"one person"
    Script: "Here's the thing." → title_chrome:"Here's", title_accent:"the thing"
  Optional: subtitle (one line under the headline), eyebrow (small
  red label above headline).

- sleek-scene-list-v1: enumerated lists. Set:
    list_title_chrome / list_title_accent — same chrome+accent pair
    items — JSON array (STRING) of {text, highlight?}, max 5 entries
  The composition auto-numbers them 01, 02, 03 from the array order.
  items array length MUST match the actual count of items in
  script_text. If the avatar says "voice, video, and image" → 3
  entries, not 5. If 6+ items, split into two segments.

- sleek-scene-claude-chat-v1: when the script literally describes
  the speaker prompting / asking / telling Claude something. Shows
  a Claude.ai-style chat UI with the user's prompt and Claude's reply
  typing out word-by-word. Slots:
    user_message     — what the speaker said to Claude. Quote it
                       verbatim from the script. Strip "I told Claude"
                       framing and keep only what was actually asked.
                       Example: script "I told Claude to build me a
                       React CRM" → user_message: "Build me a React
                       CRM."
    claude_response  — what Claude said back. If the script doesn't
                       state Claude's actual response, write a short,
                       on-brand reply (2-3 sentences, Claude voice).
                       Example: "I will set up a clean React + Supabase
                       project with auth and a deal pipeline. Let me
                       scaffold the schema first."
  Use ONLY when the script names Claude or describes prompting an AI.
  Don't use this for generic "AI did X" — needs explicit Claude mention.

- sleek-scene-cta-v1: the LAST segment of the video only. Slots:
    cta_headline_chrome / cta_headline_accent — final headline pair
    cta_subhead — one-line description under the headline
    cta_button_text — the button label, e.g. "Link In Description"
    hero_handle — big @handle bottom-center, defaults to brand handle
    eyebrow — optional small red label above headline

These are the only three compositions. There is no quote-card,
stat-reveal, comparison, lower-third, title-card, or end-card. Use
sleek-scene-headline-v1 for anything that would have been one of those.

List-item counting rule:
- The items array passed to sleek-scene-list-v1 MUST be the literal
  count of things mentioned in the script. If the avatar enumerates
  "voice, video, and image generation" → exactly 3 items. Never pad
  to make it longer, never shrink. If the script doesn't enumerate
  but loosely lists, pick the items count that fits the spoken content.

Other rules:
- Close with a clear CTA. Use end-card-v1 for the final visual (if it's in the composition pool).
- Total runtime should land within ±15% of the target duration.
- Default transition between segments: ${tmpl.default_transition || 'cut'}. Per-segment overrides allowed.

Brand context (the brand's voice, do-not-say list, hooks library, etc.) is below. Honor it exactly. Do-not-say words are non-negotiable.

${brandMarkdown}

When calling emit_video_map:
- title: derive from the topic. 8 words max.
- full_script: the complete narration, top to bottom, in the brand's voice. This is what the user will read in the script editor.
- segments: the segmented breakdown. script_text on each segment is the slice of full_script that plays during it. Keep them stitchable — concatenating script_text in order should approximate full_script.
- For voiceover_broll image_prompt: be specific. "Woman in early-30s at a desk, side-lit window light, looking at laptop, warm cinematic tone" beats "office scene." Match the visual template's color palette when relevant.
- For motion-graphics segments, set hyperframes_variables to drive the composition. Pass accent_color: "${tmpl.colors.primary_accent}" by default.

Call emit_video_map exactly once. Do not include any text outside the tool call.`
}

function buildUser(video) {
  const lines = [`Topic: ${video.topic_prompt}`]
  lines.push(`Target duration: ${video.target_duration_secs} seconds (±15%).`)
  lines.push(`Aspect ratio: ${video.aspect_ratio}.`)
  if (video.title?.trim()) lines.push(`Working title (user-supplied, you may override): ${video.title}`)
  if (video.reference_url) {
    lines.push(`\nReference video URL: ${video.reference_url}`)
    lines.push(`(Treat as inspiration. We have not auto-transcribed it; the user may have summarized the relevant parts in the reference_text below.)`)
  }
  if (video.reference_text?.trim()) {
    lines.push(`\nReference material the user provided:`)
    lines.push('<reference>')
    lines.push(video.reference_text.slice(0, 20000))
    lines.push('</reference>')
  }
  lines.push(`\nGenerate the video map now. Call emit_video_map exactly once.`)
  return lines.join('\n')
}

// Pull the tool_use block out of Claude's response.
function extractToolInput(claudeBody) {
  if (!claudeBody?.content) return null
  for (const block of claudeBody.content) {
    if (block.type === 'tool_use' && block.name === 'emit_video_map') {
      return block.input
    }
  }
  return null
}

// Bounded write helper — Claude can in theory return wild values
// despite the schema; we clamp before writing so the DB CHECK
// constraints never fire mid-insert.
// Filter overlay placements against the template's overlay_pool and
// the video's orientation. Anything Claude returns that violates either
// is silently dropped — segmentation is best-effort and the user can
// add overlays back manually via the chat editor.
function sanitizeOverlayPlacements(raw, tmpl, orientation) {
  if (!Array.isArray(raw) || !raw.length) return []
  const pool = new Set(tmpl?.overlay_pool || [])
  const out = []
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue
    if (!OVERLAY_DEFINITIONS[p.overlay_id]) continue
    if (pool.size && !pool.has(p.overlay_id)) continue
    const def = OVERLAY_DEFINITIONS[p.overlay_id]
    const zone = typeof p.zone === 'string' ? p.zone : def.default_zone
    if (!ALL_ZONES.has(zone)) continue
    if (!def.allowed_zones.includes(zone)) continue
    if (!isValidZoneForOrientation(zone, orientation)) continue
    const content = (p.content && typeof p.content === 'object') ? p.content : {}
    const placement = { overlay_id: p.overlay_id, zone, content }
    if (typeof p.start_offset_secs === 'number') placement.start_offset_secs = Math.max(0, Math.min(60, p.start_offset_secs))
    if (typeof p.duration_secs === 'number') placement.duration_secs = Math.max(0.3, Math.min(60, p.duration_secs))
    out.push(placement)
    if (out.length >= 4) break
  }
  return out
}

function sanitizeSegment(s, idx, tmpl, orientation) {
  const segment_type = SEGMENT_TYPES.includes(s.segment_type) ? s.segment_type : 'voiceover_broll'
  const transition_in = TRANSITIONS.includes(s.transition_in) ? s.transition_in : 'cut'
  const sound_effect = (typeof s.sound_effect === 'string' && SFX_LIBRARY.includes(s.sound_effect)) ? s.sound_effect : null
  const hyperframes_composition_id =
    HF_COMPOSITION_IDS.includes(s.hyperframes_composition_id) ? s.hyperframes_composition_id : null
  // Overlays only make sense on speaker footage (avatar / voiceover_broll).
  // Motion-graphics segments are already self-contained — drop overlays
  // claimed for them.
  // Visual overlays only ride speaker footage; captions ride every
  // voiceover segment. We pass through to the sanitizer for speaker
  // segments (which keeps any overlay Claude emitted), and for voiceover_
  // motion_graphics we filter down to captions only — postProcessSegments
  // will inject the actual caption placement separately.
  const speaker = segment_type === 'avatar' || segment_type === 'voiceover_broll'
  const hasVoice = speaker || segment_type === 'voiceover_motion_graphics'
  let overlay_placements
  if (speaker) {
    overlay_placements = sanitizeOverlayPlacements(s.overlay_placements, tmpl, orientation)
  } else if (hasVoice) {
    // Drop any visual overlays Claude attached to motion-graphics
    // segments — postProcess injects the caption.
    overlay_placements = (Array.isArray(s.overlay_placements) ? s.overlay_placements : [])
      .filter((p) => p?.overlay_id === 'caption-overlay-v1')
  } else {
    overlay_placements = []
  }
  return {
    segment_index: idx,
    segment_type,
    script_text: typeof s.script_text === 'string' ? s.script_text.slice(0, 2000) : null,
    image_prompt: typeof s.image_prompt === 'string' ? s.image_prompt.slice(0, 1000) : null,
    motion_gesture_prompt: typeof s.motion_gesture_prompt === 'string' ? s.motion_gesture_prompt.slice(0, 500) : null,
    hyperframes_composition_id,
    hyperframes_variables: (s.hyperframes_variables && typeof s.hyperframes_variables === 'object')
      ? s.hyperframes_variables : {},
    transition_in,
    sound_effect,
    overlay_placements,
  }
}

// Pick a "punchy" word from a phrase to highlight inside captions. Looks
// for the longest non-stopword token — good enough to land a useful
// highlight on most lines. Returns null when nothing stands out.
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
  const tokens = String(text).split(/(\s+|[.,!?;:])/).filter(Boolean)
  const candidates = tokens
    .map((t) => t.trim())
    .filter((t) => /[a-zA-Z0-9]/.test(t))
    .filter((t) => !CAPTION_STOPWORDS.has(t.toLowerCase()))
    .filter((t) => t.length >= 3)
  if (!candidates.length) return null
  // Prefer ALL-CAPS / numbers, then longest token.
  const ranked = candidates.sort((a, b) => {
    const aCaps = a === a.toUpperCase() && /[A-Z]/.test(a) ? 1 : 0
    const bCaps = b === b.toUpperCase() && /[A-Z]/.test(b) ? 1 : 0
    if (aCaps !== bCaps) return bCaps - aCaps
    const aNum = /\d/.test(a) ? 1 : 0
    const bNum = /\d/.test(b) ? 1 : 0
    if (aNum !== bNum) return bNum - aNum
    return b.length - a.length
  })
  return ranked[0]
}

// Server-side enforcement of segmentation invariants that the prompt
// asks for but can't guarantee:
//   1. Intro segment is `avatar` type — never motion_graphics.
//   2. Captions injection: every avatar / voiceover_broll segment has
//      exactly one caption-overlay-v1 placement when captions are on
//      (auto-inserted from script_text if Claude forgot); none when off.
//   3. Overlay placements are de-duplicated against pool/orientation
//      one more time as a belt-and-suspenders check.
function postProcessSegments(segments, { captionsOn, orientation, overlayPool }) {
  if (!segments?.length) return segments
  const pool = new Set(overlayPool || [])
  const out = segments.map((s, i) => ({ ...s }))

  // 1. Intro must be avatar. If Claude returned a motion_graphics intro,
  // flip the type. The avatar will speak the segment's script_text (or
  // a fallback hook line if it was empty for a motion-graphics segment).
  if (out[0]) {
    if (out[0].segment_type !== 'avatar') {
      out[0].segment_type = 'avatar'
      if (!out[0].script_text || !out[0].script_text.trim()) {
        out[0].script_text = 'Hold up.'
      }
      out[0].hyperframes_composition_id = null
      out[0].hyperframes_variables = {}
      out[0].image_prompt = null
    }
  }

  // 2. Captions injection. Captions ride EVERY voiceover segment
  // (avatar + voiceover_broll + voiceover_motion_graphics) for
  // accessibility. pure_motion_graphics has no script + no voice, so
  // gets nothing.
  for (const seg of out) {
    const hasVoice = seg.segment_type === 'avatar'
      || seg.segment_type === 'voiceover_broll'
      || seg.segment_type === 'voiceover_motion_graphics'
    if (!hasVoice) {
      // pure_motion_graphics — strip any captions Claude attached.
      seg.overlay_placements = (seg.overlay_placements || []).filter((p) => p.overlay_id !== 'caption-overlay-v1')
      continue
    }
    const existing = Array.isArray(seg.overlay_placements) ? seg.overlay_placements : []
    const hasCaption = existing.some((p) => p.overlay_id === 'caption-overlay-v1')

    if (!captionsOn) {
      seg.overlay_placements = existing.filter((p) => p.overlay_id !== 'caption-overlay-v1')
      continue
    }
    if (hasCaption) continue
    if (pool.size && !pool.has('caption-overlay-v1')) continue
    const text = (seg.script_text || '').trim()
    if (!text) continue
    const highlight = pickCaptionHighlight(text)
    seg.overlay_placements = [
      ...existing,
      {
        overlay_id: 'caption-overlay-v1',
        zone: 'lower-third',
        content: highlight ? { text, highlight } : { text },
      },
    ]
  }

  // 3. Belt-and-suspenders: orientation filter once more (e.g. drop
  // top-strip from any landscape segments that slipped through).
  for (const seg of out) {
    if (!Array.isArray(seg.overlay_placements)) continue
    seg.overlay_placements = seg.overlay_placements.filter((p) => {
      if (p.zone === 'top-strip' && orientation === 'landscape') return false
      return true
    })
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

    // Load video + verify access
    const vRows = await supaFetch(`studio_videos?id=eq.${videoId}&select=*&limit=1`)
    const video = vRows?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    // Guard: re-mapping a video that already has a final_video_url is
    // destructive — it wipes every segment (and therefore every voice/
    // image/avatar URL on those segments). The final MP4 stays around
    // in storage but the editing pipeline loses its memory of how it
    // was made. Require an explicit { confirm_wipe_render: true } flag
    // on the body so the UI can show a "Are you sure?" prompt before
    // clicking through.
    if (video.final_video_url && req.body?.confirm_wipe_render !== true) {
      return res.status(409).json({
        error: 'This video has already been rendered. Re-mapping will wipe all segments and their generated assets (voices, B-roll images, avatar videos). The final MP4 is preserved in storage but you will lose the editable map. Pass { confirm_wipe_render: true } to proceed.',
        code: 'render_exists',
        final_video_url: video.final_video_url,
      })
    }

    // Flip status → mapping so Realtime subscribers see we're working
    await supaFetch(`studio_videos?id=eq.${video.id}`, {
      method: 'PATCH',
      body: { status: 'mapping', error: null },
      prefer: 'return=minimal',
    })

    let segments = []
    let mapInput = null
    try {
      // Load brand context — same surface script_gen uses, so the
      // segmentation pass speaks in the same voice as the rest of
      // ScaleSolo's content generation.
      const ctx = await loadBrandContext(video.profile_id)
      const brandMarkdown = renderBrandContextMarkdown(ctx)

      // Resolve the visual template + brand color override. {accent}
      // placeholders inside the template get interpolated with the
      // user's chosen color (or template default if not overridden).
      // The resolved spec gets woven into the system prompt so Claude
      // segments according to template pacing + composition pool.
      const resolvedTemplate = resolveTemplate(video.template_id || 'sleek', video.brand_color)

      const claudeResp = await anthropicMessage({
        system: buildSystem(brandMarkdown, resolvedTemplate, video.captions_enabled !== false),
        messages: [{ role: 'user', content: buildUser(video) }],
        tools: [SEGMENT_TOOL],
        tool_choice: { type: 'tool', name: 'emit_video_map' },
        max_tokens: 8000,
      })
      mapInput = extractToolInput(claudeResp)
      if (!mapInput || !Array.isArray(mapInput.segments) || !mapInput.segments.length) {
        throw new Error('Claude did not return a usable video map')
      }
      const orientation = video.aspect_ratio === '9:16' ? 'vertical' : 'landscape'
      const captionsOn = video.captions_enabled !== false
      segments = mapInput.segments.map((s, i) => sanitizeSegment(s, i, resolvedTemplate, orientation))
      segments = postProcessSegments(segments, { captionsOn, orientation, overlayPool: resolvedTemplate.overlay_pool || [] })
    } catch (e) {
      // Rollback status, surface the error to the UI
      await supaFetch(`studio_videos?id=eq.${video.id}`, {
        method: 'PATCH',
        body: { status: 'failed', error: e.message },
        prefer: 'return=minimal',
      })
      return res.status(502).json({ error: `Segmentation failed: ${e.message}` })
    }

    // Wipe any existing segments — generate-map is idempotent, calling
    // it again from "regenerate map" buttons re-rolls cleanly.
    await supaFetch(`studio_segments?studio_video_id=eq.${video.id}`, {
      method: 'DELETE',
      prefer: 'return=minimal',
    }).catch(() => {})

    // Insert in one batch. Default approved=true so the user starts
    // from "everything in" and only flips off the segments they want
    // to drop. UX-wise this is much faster than approving 20+ rows
    // one at a time after every map regeneration.
    const insertRows = segments.map((s) => ({
      ...s,
      studio_video_id: video.id,
      profile_id: video.profile_id,
      status: 'pending',
      approved: true,
    }))
    await supaFetch('studio_segments', {
      method: 'POST',
      body: insertRows,
      prefer: 'return=minimal',
    })

    // Save the script + title + flip status → mapped
    const patch = {
      status: 'mapped',
      script_full_text: typeof mapInput.full_script === 'string' ? mapInput.full_script.slice(0, 100000) : null,
    }
    if (typeof mapInput.title === 'string' && mapInput.title.trim() && !video.title) {
      patch.title = mapInput.title.trim().slice(0, 200)
    }
    await supaFetch(`studio_videos?id=eq.${video.id}`, {
      method: 'PATCH', body: patch, prefer: 'return=minimal',
    })

    // Return the freshly-mapped video + segments
    const fresh = await supaFetch(
      `studio_videos?id=eq.${video.id}&select=*,studio_segments(*)&studio_segments.order=segment_index.asc&limit=1`
    )
    return res.status(200).json({ video: fresh?.[0] || null })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
