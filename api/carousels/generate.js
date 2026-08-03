// POST /api/carousels/generate
// Body: { profile_id, topic, slide_count?, reference_urls?, model?, aspect? }
// Returns: { content_id, title, caption, hashtags, images: [url,...] }
//
// Streamlined carousel builder. Claude drafts a slide plan in the brand's
// voice, each slide is rendered as a branded graphic via the existing
// credit-gated image pipeline (/api/images/generate + /status, reused in-
// process so billing/refunds are handled there), and the finished slides are
// assembled into ONE carousel draft in the calendar backlog — captioned and
// ready to schedule. Images bill the caller's ScaleSolo credits (~4,000
// ai_tokens/slide); an insufficient balance stops the run before overspending.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { message as anthropicMessage } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'
import { invokeHandler } from '../_lib/internal-invoke.js'
import { capHashtags } from '../_lib/hashtags.js'
import imagesGenerate from '../images/generate.js'
import imagesStatus from '../images/status.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Draft the slide plan + post caption from the topic, in the brand's voice.
// personMode adds a per-slide `pose` so a real person can be placed in each
// slide (two-stage Seedream portrait → GPT graphic).
async function planCarousel({ topic, slideCount, brandMd, brandColors, personMode }) {
  const schema = personMode
    ? '{ "title": string, "caption": string, "hashtags": string, "slides": [ { "kind": "cover"|"tip"|"cta", "headline": string, "body": string, "pose": string, "image_prompt": string } ] }'
    : '{ "title": string, "caption": string, "hashtags": string, "slides": [ { "kind": "cover"|"tip"|"cta", "headline": string, "body": string, "image_prompt": string } ] }'
  const out = await anthropicMessage({
    model: 'claude-sonnet-5',
    max_tokens: 2200,
    system: [
      'You plan short-form social CAROUSELS (multi-slide photo posts) for a brand.',
      'Return ONLY valid JSON, no preamble, matching exactly:',
      schema,
      '',
      `Produce EXACTLY ${slideCount} slides: slide 1 kind "cover", the last slide kind "cta", the rest "tip".`,
      'headline: punchy, <= 8 words. body: 1 short sentence (tips), empty "" for cover/cta.',
      'image_prompt: a complete prompt for an image model to render a 3:4 branded graphic for THIS slide. It MUST:',
      '  - include the EXACT slide text to render (headline), spelled correctly, as large crisp legible typography',
      `  - use the brand's colors${brandColors ? ` (${brandColors})` : ''} and a clean, cohesive, modern editorial layout consistent across all slides`,
      '  - describe composition/background so the set looks like one designed series',
      '  - NOT include watermarks, logos of other brands, page numbers, or slide numbers',
      personMode
        ? '  - COMPOSE AROUND A PERSON: the image_prompt must place the provided person on one side of the frame (keep their exact face/likeness), with the headline text laid out clearly on the other side and NOT overlapping the person.\n' +
          'pose: a short description of the person\'s pose/expression for THIS slide (e.g. "three-quarter turn, one hand raised in a precision pinch gesture, focused instructive expression, upper body only"). Vary poses across slides. No phones/props that crowd the frame.'
        : '',
      'caption: a scroll-stopping caption for the whole carousel (<= 400 chars). hashtags: at most 5, space-separated, each starting with #.',
      'NO em dashes anywhere. Use periods, commas, or "to" for ranges.',
      brandMd ? `\nBrand context:\n${brandMd}` : '',
    ].filter(Boolean).join('\n'),
    messages: [{ role: 'user', content: `Topic: ${topic}` }],
  })
  const text = (out?.content || []).map((c) => c?.text || '').join('').trim()
  const jsonStr = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  const plan = JSON.parse(jsonStr)
  if (!Array.isArray(plan?.slides) || !plan.slides.length) throw new Error('Planner returned no slides')
  return plan
}

// One credit-gated image generation via the reused image endpoints (which
// handle billing + refunds). Returns the finished (mirrored) URL. Throws on
// failure so the caller can stop the run.
async function genImage(originalReq, { profile_id, prompt, model, reference_urls, aspect }) {
  const gen = await invokeHandler(imagesGenerate, originalReq, {
    method: 'POST',
    body: { profile_id, prompt, model, aspect, count: 1, reference_urls, enhance_prompt: false },
  })
  if (gen.statusCode === 402) { const e = new Error(gen.body?.error || 'Insufficient credits'); e.code = 'insufficient_credits'; throw e }
  if (gen.statusCode >= 300) throw new Error(gen.body?.error || `image submit failed (${gen.statusCode})`)
  const taskId = gen.body?.taskId
  if (!taskId) throw new Error('image submit returned no taskId')
  for (let i = 0; i < 80; i++) {
    await sleep(3000)
    const st = await invokeHandler(imagesStatus, originalReq, { method: 'GET', query: { taskId, profile_id } })
    const state = String(st.body?.state || '').toLowerCase()
    const urls = (Array.isArray(st.body?.images) ? st.body.images : Array.isArray(st.body?.urls) ? st.body.urls : [])
      .map((u) => (typeof u === 'string' ? u : u?.url)).filter(Boolean)
    if (urls.length) return urls[0]
    if (state === 'failed') throw new Error(st.body?.error || 'slide image failed')
  }
  throw new Error('slide image timed out')
}

// Render one slide. In person mode: Seedream makes a photoreal portrait of the
// person from their photos in the slide's pose, then GPT Image 2 composes the
// branded graphic (crisp text + layout) around that portrait — the two-stage
// likeness pipeline. Otherwise: one graphic via nano-banana.
async function renderSlide(originalReq, { profile_id, slide, model, personRefs, aspect }) {
  if (personRefs && personRefs.length) {
    const portraitPrompt = `Photoreal, high-quality portrait of the person from the reference image(s). ${slide.pose || 'upper body, three-quarter turn, confident expression'}. Plain neutral background, natural studio lighting, keep their exact face, hair, skin tone, and proportions identical to the references. No text.`
    const portrait = await genImage(originalReq, { profile_id, prompt: portraitPrompt, model: 'seedream', reference_urls: personRefs, aspect })
    const composePrompt = `${slide.image_prompt}\n\nPlace the person from the reference image naturally in the frame. Keep their exact face and likeness from the reference. The person occupies one side; the headline text is on the other side and must not overlap the person.`
    return await genImage(originalReq, { profile_id, prompt: composePrompt, model: 'gpt-2', reference_urls: [portrait], aspect })
  }
  return await genImage(originalReq, { profile_id, prompt: slide.image_prompt, model, reference_urls: undefined, aspect })
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, topic, slide_count = 6, reference_urls, person_mode = false, model = 'nano-banana', aspect = '3:4' } = req.body || {}
    if (!profile_id || !topic) return res.status(400).json({ error: 'profile_id + topic required' })
    await assertProfileAccess(auth.user.id, profile_id)
    const n = Math.max(3, Math.min(8, Number(slide_count) || 6))
    const personRefs = (person_mode && Array.isArray(reference_urls)) ? reference_urls.filter(Boolean) : null
    if (person_mode && !(personRefs && personRefs.length)) {
      return res.status(400).json({ error: 'Person mode needs reference_urls (1-3 photos of the person).' })
    }

    // Brand voice + colors for a cohesive, on-brand set.
    let brandMd = '', brandColors = ''
    try {
      const ctx = await loadBrandContext(profile_id)
      brandMd = renderBrandContextMarkdown(ctx, { exclude: ['exemplars'] })
      const pr = await supaFetch(`profiles?id=eq.${profile_id}&select=brand_color,brand_color_secondary`)
      const p = pr?.[0]
      brandColors = [p?.brand_color, p?.brand_color_secondary].filter(Boolean).join(' and ')
    } catch { /* brandless is fine */ }

    const plan = await planCarousel({ topic, slideCount: n, brandMd, brandColors, personMode: !!personRefs })
    const slides = plan.slides.slice(0, n)

    // Render slides in parallel (each image bills + refunds independently). If
    // any slide fails, surface it — a partial carousel isn't useful.
    // Insufficient credits stops with a clear 402.
    let urls
    try {
      urls = await Promise.all(slides.map((s) => renderSlide(req, {
        profile_id, slide: s, model, personRefs, aspect,
      })))
    } catch (e) {
      if (e.code === 'insufficient_credits') {
        return res.status(402).json({ error: `Not enough credits to render ${n} slides (~${4000 * n} ai_tokens). ${e.message}`, code: 'insufficient_credits' })
      }
      return res.status(502).json({ error: `Slide generation failed: ${e.message}` })
    }

    // Assemble one carousel draft in the backlog.
    const title = String(plan.title || topic).slice(0, 120)
    const caption = String(plan.caption || '').slice(0, 5000)
    const hashtags = capHashtags(plan.hashtags, 5)
    const inserted = await supaFetch('content_scripts', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        profile_id, title, caption, hashtags,
        media_urls: urls, media_type: 'carousel', post_type: 'post',
        status: 'draft', generated_by: 'carousel-builder',
      },
    })
    const row = Array.isArray(inserted) ? inserted[0] : inserted
    return res.status(200).json({
      content_id: row?.id || null,
      title, caption, hashtags,
      images: urls,
      status: 'draft (in the calendar backlog)',
    })
  } catch (err) {
    if (err?.code === 'insufficient_credits') return res.status(402).json({ error: err.message, code: 'insufficient_credits' })
    return res.status(err.status || 500).json({ error: err.message })
  }
}
