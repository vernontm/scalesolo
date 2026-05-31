// POST /api/avatars/looks/generate
//
// One endpoint handling both phases of the unified "New Look" survey flow:
//
//   mode='compose'  — Merge avatar + outfit + environment reference photos
//                     into one hero shot. Up to 3 input_urls passed to
//                     Kie's gpt-image-2-image-to-image. Returns a single
//                     task_id the client polls via /poll-generation.
//
//   mode='angles'   — Given an approved hero shot, dispatch FOUR Kie tasks
//                     for hero/45L/45R/90L podcast-style coverage. Returns
//                     the 4 task_ids in stable order [hero, 45L, 45R, 90L].
//
// Body:
//   {
//     mode: 'compose' | 'angles',
//     profile_id,                            // for access check
//     aspect_ratio: '1:1' | '4:5' | '9:16' | '16:9',
//
//     // compose mode
//     avatar_image_url,                      // required for compose
//     outfit_image_url?,                     // optional
//     environment_image_url?,                // optional
//     // When environment_image_url is missing, fall back to taking the
//     // background from one of the other refs. Sent to Claude as a
//     // styling instruction; we don't crop locally.
//     background_source?: 'avatar' | 'outfit',
//
//     // angles mode
//     hero_image_url,                        // required for angles
//   }
//
// Returns: { task_ids: [...] } (1 entry for compose, 4 for angles).
//
// No DB writes here. The look isn't created until the user confirms in
// the modal — we just dispatch image-gen tasks and hand back ids.

import { setCors, requireUser, assertProfileAccess } from '../../_lib/supabase.js'

export const config = { maxDuration: 30 }

// Stable order for the angle pass. The UI grid renders in this exact
// order so the user sees Hero on the left and ramps L→R as they scan.
const ANGLE_PROMPTS = {
  hero: `Front-facing, eye-level hero shot. The subject is looking directly at the camera as if mid-sentence on a podcast. Subtle hand gesture frozen in motion. Same person, same outfit, same environment as the reference. Keep facial features, hair, build, age, ethnicity, clothing details, lighting, and background identical to the reference. Only the camera angle and pose change.`,
  '45_left': `Three-quarter angle from the subject's LEFT side, roughly 45 degrees off-axis. The camera sees more of the right side of the subject's face. Eye-level. The subject is still talking, mid-sentence, with a subtle hand gesture. Same person, same outfit, same environment as the reference. Keep facial features, hair, build, age, ethnicity, clothing details, lighting, and background identical to the reference. Only the camera angle changes.`,
  '45_right': `Three-quarter angle from the subject's RIGHT side, roughly 45 degrees off-axis. The camera sees more of the left side of the subject's face. Eye-level. The subject is still talking, mid-sentence, with a subtle hand gesture. Same person, same outfit, same environment as the reference. Keep facial features, hair, build, age, ethnicity, clothing details, lighting, and background identical to the reference. Only the camera angle changes.`,
  '90_left': `Hard left profile, 90 degrees off-axis. The camera sees only the right side of the subject's face in a clean profile. Eye-level. The subject is still talking, mid-sentence, with a subtle hand gesture. Same person, same outfit, same environment as the reference. Keep facial features, hair, build, age, ethnicity, clothing details, lighting, and background identical to the reference. Only the camera angle changes.`,
}
const ANGLE_ORDER = ['hero', '45_left', '45_right', '90_left']

// Compose prompt — builds the hero shot from up to 3 reference photos.
// We anchor identity (face, hair, build) to the avatar photo, anchor
// wardrobe to the outfit photo, and anchor background/lighting to
// either the environment photo or the chosen fallback.
function buildComposePrompt({ hasOutfit, hasEnv, backgroundSource, orientation }) {
  const parts = []
  parts.push('Studio-quality podcast portrait of the person from the first reference image. They are seated or standing at podcast distance, looking directly at the camera as if mid-sentence with a subtle hand gesture. Eye-level framing, soft cinematic lighting.')
  parts.push('Keep their face, hair, build, age, ethnicity, and overall identity IDENTICAL to the first reference. No alterations to their features.')
  if (hasOutfit) {
    parts.push('They are wearing the EXACT outfit from the second reference image — same garment shapes, fabric, colors, patterns, and accessories. Adapt the fit naturally to their body but do not redesign the outfit.')
  }
  if (hasEnv) {
    parts.push('They are in the environment shown in the third reference image — same room, set dressing, lighting mood, and color palette. The subject sits/stands within the scene, not in front of a cutout.')
  } else if (backgroundSource === 'outfit' && hasOutfit) {
    parts.push('Use the background and lighting from the outfit reference image as the environment.')
  } else {
    parts.push('Use the background and lighting from the avatar reference image as the environment.')
  }
  parts.push(orientation === 'vertical'
    ? 'Vertical 9:16 framing, the subject centered with comfortable headroom and chest-up framing.'
    : 'Horizontal 16:9 framing, the subject framed chest-up slightly off-center as if they are addressing one of two podcast microphones.')
  parts.push('Photorealistic. Sharp focus on the eyes. No text, watermarks, or graphic overlays. No extra people in frame.')
  return parts.join(' ')
}

async function dispatchKieTask({ apiKey, prompt, inputUrls, aspect }) {
  const usesImage = Array.isArray(inputUrls) && inputUrls.length > 0
  const body = {
    model: usesImage ? 'gpt-image-2-image-to-image' : 'gpt-image-2-text-to-image',
    input: {
      prompt: prompt.slice(0, 20000),
      aspect_ratio: aspect,
      resolution: '2K',
    },
  }
  if (usesImage) body.input.input_urls = inputUrls.slice(0, 16)
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 30_000)
  let resp
  try {
    resp = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('Kie.ai submit timed out after 30s')
    throw e
  } finally {
    clearTimeout(t)
  }
  const text = await resp.text()
  let parsed = {}
  try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
  if (!resp.ok || (parsed?.code && parsed.code !== 200)) {
    throw new Error(`Kie.ai submit failed (${resp.status}): ${parsed?.msg || parsed?.error || text.slice(0, 200)}`)
  }
  const taskId = parsed?.data?.taskId || parsed?.data?.task_id || parsed?.taskId
  if (!taskId) throw new Error('Kie.ai returned no taskId')
  return taskId
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  const apiKey = process.env.KIE_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'KIE_API_KEY not configured' })

  try {
    const body = req.body || {}
    const {
      mode, profile_id,
      aspect_ratio: rawAspect,
      avatar_image_url, outfit_image_url, environment_image_url,
      background_source,
      hero_image_url,
    } = body
    if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
    await assertProfileAccess(auth.user.id, profile_id)

    const aspect = (rawAspect === '9:16' || rawAspect === '16:9' || rawAspect === '4:5' || rawAspect === '1:1')
      ? rawAspect
      : '9:16'
    const orientation = aspect === '16:9' ? 'horizontal' : 'vertical'

    if (mode === 'compose') {
      if (!avatar_image_url) return res.status(400).json({ error: 'avatar_image_url required for compose' })
      const inputs = [avatar_image_url, outfit_image_url, environment_image_url].filter(Boolean)
      const prompt = buildComposePrompt({
        hasOutfit: !!outfit_image_url,
        hasEnv: !!environment_image_url,
        backgroundSource: background_source || 'avatar',
        orientation,
      })
      const taskId = await dispatchKieTask({ apiKey, prompt, inputUrls: inputs, aspect })
      return res.status(200).json({ task_ids: [{ angle: 'compose', task_id: taskId }] })
    }

    if (mode === 'angles') {
      if (!hero_image_url) return res.status(400).json({ error: 'hero_image_url required for angles' })
      // Dispatch the 4 angle prompts in parallel — Kie's createTask is
      // fast (~1-3s each) so doing them concurrently shaves the
      // dispatch time roughly 4x. Each carries the approved hero shot
      // as its single reference so the model only has to change the
      // camera angle / pose.
      const dispatches = await Promise.all(ANGLE_ORDER.map(async (angle) => {
        try {
          const taskId = await dispatchKieTask({
            apiKey,
            prompt: ANGLE_PROMPTS[angle],
            inputUrls: [hero_image_url],
            aspect,
          })
          return { angle, task_id: taskId, error: null }
        } catch (e) {
          return { angle, task_id: null, error: e?.message || String(e) }
        }
      }))
      const successes = dispatches.filter((d) => d.task_id)
      if (!successes.length) {
        return res.status(502).json({
          error: 'All angle dispatches failed',
          dispatches,
        })
      }
      return res.status(200).json({ task_ids: dispatches })
    }

    return res.status(400).json({ error: `Unknown mode: ${mode}` })
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || String(e) })
  }
}
