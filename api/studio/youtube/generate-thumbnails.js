// POST /api/studio/youtube/generate-thumbnails
//
// Two-stage thumbnail generator:
//   1. Claude reads the video's topic + title + script summary + the
//      profile's reference thumbnails (visual analysis via image input)
//      and writes 3 thumbnail PROMPTS that match the brand's style.
//   2. Each prompt is sent to Kie nano-banana-2 to render an actual
//      1280x720 thumbnail. When the prompt references a person and the
//      video uses an avatar, the avatar look's cover image is passed
//      as image_input so the generated face matches the host.
//
// Returns: { candidates: [{ url, prompt }] }
// Side effect: stores the candidate URLs in studio_videos.thumbnail_candidates

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../../_lib/supabase.js'
import { gateStudio } from '../_lib/gate.js'
import { message as anthropicMessage } from '../../_lib/anthropic.js'

export const config = { maxDuration: 120, memory: 1024 }

const KIE_BASE = 'https://api.kie.ai'
const STUDIO_BUCKET = 'studio-media'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

// Submit a nano-banana-2 image task. Mirrors the createTask shape from
// generate-assets.js dispatchImage but tailored for YouTube thumbnails
// (16:9, large bold text overlays, high contrast). Returns the Kie
// taskId — we poll synchronously below since we only generate 3 images
// and the user is waiting in the modal.
async function submitThumbTask({ prompt, apiKey, imageInput }) {
  // GPT Image-2 on Kie. Two variants:
  //   - gpt-image-2-text-to-image: prompt only, fastest path
  //   - gpt-image-2-image-to-image: prompt + reference images, used when
  //     we have the host's avatar photo to anchor the face
  //
  // Picked over nano-banana-2 because GPT-Image-2 is dramatically better
  // at rendering bold readable text overlays, which is most of the win
  // on YouTube thumbnails. Resolution stays at 2K so the 1280x720
  // crop has headroom; aspect_ratio 16:9 matches YouTube native.
  const usesImage = Array.isArray(imageInput) && imageInput.length > 0
  const body = {
    model: usesImage ? 'gpt-image-2-image-to-image' : 'gpt-image-2-text-to-image',
    input: {
      prompt: prompt.slice(0, 20000),
      aspect_ratio: '16:9',
      resolution: '2K',
    },
  }
  if (usesImage) {
    body.input.input_urls = imageInput.slice(0, 16)
  }
  const r = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let data = {}
  try { data = JSON.parse(text) } catch {}
  if (!r.ok || (data?.code && data.code !== 200)) {
    throw new Error(`Kie createTask ${r.status}: ${(data?.msg || text).slice(0, 240)}`)
  }
  const taskId = data?.data?.taskId || data?.taskId
  if (!taskId) throw new Error(`Kie response missing taskId: ${text.slice(0, 200)}`)
  return taskId
}

// Extract image URLs from a Kie recordInfo response. Same parsing logic
// used by api/images/generate.js — Kie wraps the URL inside resultJson,
// which is a JSON-encoded STRING containing { resultUrls: [...] }. My
// first attempt at this missed that because the URL lives inside a
// stringified field, not as an object property.
function parseKieResultUrls(data) {
  let out = []
  const rj = data?.resultJson
  if (typeof rj === 'string') {
    try {
      const parsed = JSON.parse(rj)
      if (Array.isArray(parsed?.resultUrls)) out = parsed.resultUrls
      else if (Array.isArray(parsed)) out = parsed
    } catch {}
  } else if (rj && Array.isArray(rj.resultUrls)) {
    out = rj.resultUrls
  }
  if (!out.length) {
    out = data?.resultUrls
      || data?.result?.urls
      || data?.images?.map?.((i) => i.url || i)
      || []
  }
  return (Array.isArray(out) ? out : []).filter(Boolean)
}

// Poll Kie until the task lands a URL or fails. ~90s max to stay inside
// our 120s function ceiling.
async function pollThumbTask(taskId, apiKey, maxMs = 90000) {
  const start = Date.now()
  let lastBody = null
  while (Date.now() - start < maxMs) {
    const r = await fetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const text = await r.text()
    let body = {}
    try { body = JSON.parse(text) } catch {}
    lastBody = body
    const data = body?.data || body
    const state = String(data?.state || data?.status || '').toLowerCase()
    if (state === 'fail' || state === 'failed' || state === 'error') {
      throw new Error(data?.failMsg || data?.errorMessage || 'Kie task failed')
    }
    const urls = parseKieResultUrls(data)
    if (urls.length) return urls[0]
    // If the task reports completion but parseKieResultUrls found
    // nothing, log diagnostics + bail. Should be rare now that we use
    // the same parser as the working Spaces image-gen flow.
    if (['success', 'completed', 'done', 'finished'].includes(state)) {
      console.warn(`[generate-thumbnails] task ${taskId} reports ${state} but no URL found. Body keys: ${JSON.stringify(Object.keys(data || {})).slice(0, 200)}`)
      console.warn(`[generate-thumbnails] task ${taskId} body: ${JSON.stringify(data).slice(0, 800)}`)
      throw new Error(`Kie task completed but no image URL in response (state=${state}, keys=${Object.keys(data || {}).join(',')})`)
    }
    await new Promise((r) => setTimeout(r, 2500))
  }
  // Timeout path — surface the last seen body in the error so we can
  // see what state Kie was reporting.
  const lastState = (lastBody?.data?.state || lastBody?.data?.status || 'unknown')
  throw new Error(`Kie task did not complete in time (lastState=${lastState})`)
}

// Mirror to our own storage so the URL is stable + public + permanent.
async function mirrorToStorage(remoteUrl, profileId, videoId) {
  const dl = await fetch(remoteUrl)
  if (!dl.ok) throw new Error(`mirror download ${dl.status}`)
  const buf = Buffer.from(await dl.arrayBuffer())
  const path = `${profileId}/studio/youtube-thumbnails/auto-${videoId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
  const up = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${STUDIO_BUCKET}/${encodeURI(path)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'image/jpeg',
        'x-upsert': 'true',
      },
      body: buf,
    },
  )
  if (!up.ok) {
    const detail = await up.text().catch(() => '')
    throw new Error(`mirror upload ${up.status}: ${detail.slice(0, 200)}`)
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${STUDIO_BUCKET}/${path}`
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    gateStudio(auth.user.id)
    const { studio_video_id } = req.body || {}
    if (!studio_video_id) return res.status(400).json({ error: 'studio_video_id required' })

    const videos = await supaFetch(
      `studio_videos?id=eq.${studio_video_id}&select=id,profile_id,title,topic_prompt,script_full_text,avatar_id,look_id`,
    )
    const video = videos?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    // Pull profile context: thumbnail refs + brand colors + visual style.
    const profileRows = await supaFetch(
      `profiles?id=eq.${video.profile_id}&select=youtube_thumbnail_references,brand_primary_color,brand_secondary_color,visual_style_guide,visual_keywords,business_name,owner_name&limit=1`,
    )
    const profile = profileRows?.[0] || {}
    const thumbRefs = Array.isArray(profile.youtube_thumbnail_references) ? profile.youtube_thumbnail_references : []

    // Resolve avatar look image when the video uses an avatar — we use
    // this as person-reference input to Kie so the generated thumbnail
    // face matches the host.
    let avatarReferenceImageUrl = ''
    if (video.look_id) {
      try {
        const looks = await supaFetch(`avatar_looks?id=eq.${video.look_id}&select=cover_image_url,photo_url&limit=1`)
        const look = looks?.[0] || {}
        avatarReferenceImageUrl = look.cover_image_url || look.photo_url || ''
      } catch { /* best-effort */ }
    }
    if (!avatarReferenceImageUrl && video.avatar_id) {
      try {
        const avatars = await supaFetch(`avatars?id=eq.${video.avatar_id}&select=photo_url&limit=1`)
        avatarReferenceImageUrl = avatars?.[0]?.photo_url || ''
      } catch { /* best-effort */ }
    }

    // Step 1: Claude writes 3 thumbnail prompts. References are sent as
    // image blocks so Claude can see the actual style (colors, layout,
    // text treatment) instead of just being told about it.
    const brandBits = []
    if (profile.brand_primary_color) brandBits.push(`Primary brand color: ${profile.brand_primary_color}`)
    if (profile.brand_secondary_color) brandBits.push(`Secondary brand color: ${profile.brand_secondary_color}`)
    if (profile.visual_style_guide) brandBits.push(`Style guide: ${profile.visual_style_guide.slice(0, 400)}`)
    if (Array.isArray(profile.visual_keywords) && profile.visual_keywords.length) {
      brandBits.push(`Visual keywords: ${profile.visual_keywords.join(', ')}`)
    }
    const personHostName = profile.owner_name || profile.business_name || 'the host'
    const useAvatar = !!avatarReferenceImageUrl

    const userContentBlocks = [
      {
        type: 'text',
        text:
          `Brand: ${profile.business_name || profile.owner_name || 'creator'}\n` +
          `Video title: ${video.title || video.topic_prompt || '(untitled)'}\n` +
          `Topic prompt: ${video.topic_prompt || '(none)'}\n` +
          `Opening of script: ${(video.script_full_text || '').slice(0, 600)}\n\n` +
          (brandBits.length ? `${brandBits.join('\n')}\n\n` : '') +
          (useAvatar
            ? `IMPORTANT: This video uses an avatar host named ${personHostName}. If a prompt features a person, describe them in a way that the Kie image model can render. The model will be given the host's actual photo as a reference, so just describe expression, pose, lighting, framing — NOT facial features. Use "${personHostName}" by name.\n\n`
            : `This video does not use an avatar host. Do not feature a specific person; use abstract subjects, hands, objects, screens, environments.\n\n`) +
          (thumbRefs.length
            ? `Reference thumbnails from this creator (visual style inspiration — match their composition, color usage, text treatment):`
            : `No reference thumbnails available — use modern YouTube best practices: high contrast, bold colors, one subject, large readable text on a 1280x720 canvas.'`),
      },
    ]
    // Attach up to 4 reference thumbnails as image blocks. Claude vision
    // analyzes them inline. The Anthropic API accepts publicly-fetchable
    // URLs via the `image` block with `source.type='url'`.
    for (const refUrl of thumbRefs.slice(0, 4)) {
      if (typeof refUrl === 'string' && /^https?:\/\//.test(refUrl)) {
        userContentBlocks.push({
          type: 'image',
          source: { type: 'url', url: refUrl },
        })
      }
    }

    const system =
      'You design YouTube thumbnail PROMPTS for an AI image generator (Kie nano-banana-2, 1280x720). Output 3 distinct thumbnail concepts via the emit_thumbnails tool.\n\n' +
      '## IMPORTANT — analyzing reference thumbnails\n' +
      'When reference thumbnails are attached, IGNORE these YouTube UI elements that get captured in screenshots — they are NOT part of the creator\'s design and must never appear in your prompts:\n' +
      '  - Duration/timestamp badge in the bottom-right corner (e.g. "12:34", "0:58")\n' +
      '  - "CC" closed-caption badge\n' +
      '  - 4K / HD / Live badges\n' +
      '  - Progress bar at the bottom edge (red watched-line)\n' +
      '  - "From [Channel Name]" overlays\n' +
      '  - Watermark logos auto-pinned to corners\n' +
      'Focus ONLY on the artwork the creator designed: subject, composition, lighting, color palette, headline text treatment, framing. Never describe or reproduce any timestamp, runtime, badge, or progress bar in your output prompts.\n\n' +
      '## What makes a thumbnail click\n' +
      '  - ONE clear subject, large in the frame. No tiny details that vanish at small sizes.\n' +
      '  - High contrast: bright subject against dark background, or vice versa.\n' +
      '  - 2-5 word headline TEXT baked into the image, big enough to read on mobile.\n' +
      '  - Strong emotion (surprise, excitement, focus, disbelief) on faces when present.\n' +
      '  - Brand colors used as accents, not the whole canvas.\n' +
      '  - Avoid: small text walls, generic stock-photo poses, low contrast, busy backgrounds, watermarks, timestamps, duration badges, progress bars.\n\n' +
      '## Variety across the 3 concepts\n' +
      '  Concept 1 — Subject-driven (the host or main object front and center, dramatic lighting)\n' +
      '  Concept 2 — Concept/metaphor (abstract visual that illustrates the core idea)\n' +
      '  Concept 3 — Reaction/text-led (expressive face or hand gesture + bold overlay text)\n\n' +
      '## Output\n' +
      'Each thumbnail in the array has:\n' +
      '  - prompt: 2-4 sentences describing the visual scene. Lead with subject, then environment, then lighting, then text overlay if any. Mention exact text overlays in quotes like \'with the text "MISSED THE SHIFT" in bold yellow\'. Be specific about composition.\n' +
      '  - overlay_text: the 2-5 word headline text that should appear in the image (or empty if no text overlay).\n' +
      '  - style: short label for this concept (e.g. "Dramatic portrait", "Abstract metaphor", "Reaction shot").\n' +
      '  - features_person: TRUE if the concept features a human (the host, a person, a face, hands) in the image. FALSE if it is purely abstract / objects / environment / text. Be honest — this routes the image generator to use the host\'s actual reference photo when true. Mark TRUE for any portrait, reaction shot, "host doing X", hands-on-keyboard, or anything where you describe a person.\n\n' +
      (useAvatar
        ? `When features_person is TRUE, the image generator will be given the host's actual reference photo as an image input. Your prompt should describe the SCENE around the host (lighting, environment, expression, pose, framing) and use "${personHostName}" by name. Do NOT describe their race, hair color, age, or facial features — those come from the reference photo, not your prompt. Words you describe will override the reference, so keep facial description out.\n\n`
        : '') +
      'No emoji. No quote marks around the whole prompt. Output ONLY via the tool.'

    const claudeResp = await anthropicMessage({
      system,
      messages: [{ role: 'user', content: userContentBlocks }],
      max_tokens: 2000,
      tools: [{
        name: 'emit_thumbnails',
        description: 'Return 3 thumbnail concepts',
        input_schema: {
          type: 'object',
          properties: {
            thumbnails: {
              type: 'array',
              minItems: 3,
              maxItems: 3,
              items: {
                type: 'object',
                properties: {
                  prompt: { type: 'string' },
                  overlay_text: { type: 'string' },
                  style: { type: 'string' },
                  // Explicit signal: does this concept feature the host
                  // (or any human face) in the image? Drives whether
                  // we route to gpt-image-2-image-to-image with the
                  // avatar reference vs. text-to-image. Don't rely on
                  // a regex sniff of the prompt — Claude knows best.
                  features_person: {
                    type: 'boolean',
                    description: 'True if this concept features the host or any person/face. False for abstract/object-only concepts.',
                  },
                },
                required: ['prompt', 'style', 'features_person'],
              },
            },
          },
          required: ['thumbnails'],
        },
      }],
      tool_choice: { type: 'tool', name: 'emit_thumbnails' },
      cache_system: false,
    })

    const toolBlock = (claudeResp?.content || []).find((b) => b.type === 'tool_use')
    const thumbnails = toolBlock?.input?.thumbnails
    if (!Array.isArray(thumbnails) || thumbnails.length === 0) {
      return res.status(502).json({ error: 'Claude did not return thumbnail prompts.' })
    }

    // Step 2: dispatch all 3 Kie image tasks in parallel.
    const kieKey = process.env.KIE_API_KEY
    if (!kieKey) return res.status(500).json({ error: 'KIE_API_KEY not configured.' })

    // Route to image-to-image whenever Claude flagged the concept as
    // featuring a person AND we have an avatar reference photo. The
    // earlier regex-sniff missed concepts that referred to the host
    // implicitly (e.g. by name without using "face" / "portrait"),
    // which is how a random stranger ended up in the "Reaction
    // close-up" tile instead of the actual avatar.
    const results = await Promise.allSettled(thumbnails.map(async (t, i) => {
      const wantsPerson = useAvatar && t.features_person === true
      const imageInput = wantsPerson ? [avatarReferenceImageUrl] : []
      const taskId = await submitThumbTask({ prompt: t.prompt, apiKey: kieKey, imageInput })
      const remoteUrl = await pollThumbTask(taskId, kieKey)
      const url = await mirrorToStorage(remoteUrl, video.profile_id, video.id)
      return {
        url,
        prompt: t.prompt,
        overlay_text: t.overlay_text || '',
        style: t.style || `Concept ${i + 1}`,
        features_person: !!t.features_person,
      }
    }))

    const candidates = []
    const errors = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') candidates.push(r.value)
      else errors.push({ index: i, error: r.reason?.message || String(r.reason) })
    })

    if (!candidates.length) {
      return res.status(502).json({ error: `All 3 thumbnail generations failed. First error: ${errors[0]?.error}` })
    }

    // Persist so the user can re-open the modal without re-spending.
    // Surface persist failures in the response — earlier the silent
    // catch was hiding the issue while client state showed "success."
    let persistError = null
    try {
      await supaFetch(`studio_videos?id=eq.${video.id}`, {
        method: 'PATCH',
        body: { thumbnail_candidates: candidates },
        prefer: 'return=minimal',
      })
    } catch (e) {
      persistError = e?.message || String(e)
      console.warn(`[generate-thumbnails] persist failed for video ${video.id}: ${persistError}`)
    }

    return res.status(200).json({ candidates, errors, persistError })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
