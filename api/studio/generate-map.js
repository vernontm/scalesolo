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

// The composition library the segmentation pass is allowed to pick
// from. Stable ids — the actual HTML compositions ship in task #8.
// Keeping this allowlist server-side prevents Claude from hallucinating
// composition ids the renderer can't honor.
const HF_COMPOSITION_IDS = [
  'title-card-v1',       // Big text reveal — hooks, section breaks
  'stat-reveal-v1',      // Single number + label (e.g. "403,840 views")
  'list-overlay-v1',     // 3-5 bullet points stacked in
  'quote-card-v1',       // Pull quote with attribution
  'lower-third-v1',      // Name + role chip in the bottom corner
  'comparison-v1',       // Two-column side-by-side
  'end-card-v1',         // CTA + handle at the end
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
          },
        },
      },
    },
  },
}

function buildSystem(brandMarkdown) {
  return `You are Studio's segmentation engine. Your job: turn a topic into a long-form vertical or horizontal video, broken into 4-to-7-second segments that flow like a YouTube short-form-meets-explainer.

You will draft a full script in the brand's voice, then beat it into segments. Every segment is one of:
- avatar: the brand's AI avatar speaks this line on camera
- voiceover_broll: voiceover plays over a generated still image (B-roll)
- voiceover_motion_graphics: voiceover plays over an animated HyperFrames composition (title cards, stat reveals, lists, quotes)
- pure_motion_graphics: no voiceover, just motion graphics with optional SFX/music (transitions, section breaks, stings)

Pacing rules:
- Average segment duration is 4 to 6 seconds. Hook segments (first 2 seconds) can be 2 to 3.
- Vary the rhythm: fast-fast-slow-fast keeps retention up.
- Vary segment types: never put 3 avatar segments in a row, never put 3 broll segments in a row.
- Open with an avatar or motion graphic hook in the first 2 seconds.
- Close with a clear CTA. Use end-card-v1 for the final visual.
- Total runtime should land within ±15% of the target duration.

Brand context (the brand's voice, do-not-say list, hooks library, etc.) is below. Honor it exactly. Do-not-say words are non-negotiable.

${brandMarkdown}

When calling emit_video_map:
- title: derive from the topic. 8 words max.
- full_script: the complete narration, top to bottom, in the brand's voice. This is what the user will read in the script editor.
- segments: the segmented breakdown. script_text on each segment is the slice of full_script that plays during it. Keep them stitchable — concatenating script_text in order should approximate full_script.
- Use HyperFrames compositions liberally to add visual rhythm. A 2-minute video should have 6 to 10 motion-graphics segments mixed with avatar and broll.
- For voiceover_broll image_prompt: be specific. "Woman in early-30s at a desk, side-lit window light, looking at laptop, warm cinematic tone" beats "office scene."

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
function sanitizeSegment(s, idx) {
  const segment_type = SEGMENT_TYPES.includes(s.segment_type) ? s.segment_type : 'voiceover_broll'
  const transition_in = TRANSITIONS.includes(s.transition_in) ? s.transition_in : 'cut'
  const sound_effect = (typeof s.sound_effect === 'string' && SFX_LIBRARY.includes(s.sound_effect)) ? s.sound_effect : null
  const hyperframes_composition_id =
    HF_COMPOSITION_IDS.includes(s.hyperframes_composition_id) ? s.hyperframes_composition_id : null
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
  }
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

      const claudeResp = await anthropicMessage({
        system: buildSystem(brandMarkdown),
        messages: [{ role: 'user', content: buildUser(video) }],
        tools: [SEGMENT_TOOL],
        tool_choice: { type: 'tool', name: 'emit_video_map' },
        max_tokens: 8000,
      })
      mapInput = extractToolInput(claudeResp)
      if (!mapInput || !Array.isArray(mapInput.segments) || !mapInput.segments.length) {
        throw new Error('Claude did not return a usable video map')
      }
      segments = mapInput.segments.map(sanitizeSegment)
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
