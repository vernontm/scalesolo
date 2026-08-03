// Carousel generation engine — the pipeline logic, split into resumable STEPS
// so a background worker can run it a step at a time and never hit the
// serverless time limit. runStep(req, job) executes the job's current step and
// returns a patch to persist. Steps: plan → cover → slide (per follower) →
// composite → done. Each step is idempotent: if its output already exists in
// job.state it is skipped, so a retried step never double-charges.

import { supaFetch } from './supabase.js'
import { message as anthropicMessage } from './anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from './brand-context.js'
import { invokeHandler } from './internal-invoke.js'
import { capHashtags } from './hashtags.js'
import { compositeLockup } from './carousel-lockup.js'
import { compositeSlideText } from './carousel-text.js'
import imagesGenerate from '../images/generate.js'
import imagesStatus from '../images/status.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const THEME_PROMPTS = {
  modern: 'Clean modern editorial design, crisp geometric sans-serif type, generous negative space, refined and premium.',
  bold: 'Bold high-impact design, heavy oversized uppercase sans-serif headlines, strong color blocking, punchy and confident.',
  edgy: 'Rough edgy street aesthetic, distressed grunge textures, gritty high-contrast, torn and spray-paint accents, raw energy.',
  cursive: 'Elegant flowing script and cursive headlines paired with a clean supporting sans, refined, luxurious, hand-lettered feel.',
  futuristic: 'Futuristic sci-fi aesthetic, sleek techno typography, neon glow, glassmorphism panels, HUD accents, dark gradient background.',
  minimal: 'Ultra minimal editorial, elegant serif type, muted monochrome palette, lots of whitespace, calm and sophisticated.',
  retro: 'Retro vintage aesthetic, warm nostalgic palette, film grain texture, throwback display typography.',
}
const THEME_INK = {
  modern: 'dark', bold: 'dark', cursive: 'dark', minimal: 'dark', retro: 'dark',
  edgy: 'light', futuristic: 'light',
}
const FORMAT_GUIDES = {
  listicle: 'A numbered LISTICLE. The cover promises a count (e.g. "5 X"); each tip slide is ONE numbered item ("1.", "2.", ...) with a short headline + one line.',
  howto: 'A step-by-step HOW-TO / tutorial. Each tip slide is one sequential step ("Step 1", "Step 2", ...) in order.',
  tips: 'Standalone quick TIPS. Each tip slide is one punchy, self-contained tip. No strict numbering required.',
  mythfact: 'MYTH vs FACT. Each tip slide states a common myth then the truth ("Myth: ... / Truth: ...").',
  story: 'A STORY arc that builds. Cover hooks, tip slides advance a narrative or mini case study, last slide lands the lesson + CTA.',
  checklist: 'A screenshot-worthy CHECKLIST. Each tip slide is one checklist item with a check-style bullet.',
  questions: 'Common QUESTIONS answered. Each tip slide poses one question as the headline and answers it in the body.',
}
const CAMERA = (
  'Photorealistic studio portrait, 85mm lens look, soft directional key light with gentle fill, '
  + 'natural visible skin texture and pores, sharp DSLR realism, subtle natural imperfections. '
  + 'NOT CGI, not 3D-rendered, not a digital painting, not airbrushed or plastic.'
)
const DEFAULT_POSES = [
  'arms crossed loosely across the chest, shoulders squared, chin slightly lifted, direct confident eye contact',
  'three-quarter turn, one hand raised near chest in a precision pinch gesture, focused instructive expression',
  'mid-gesture mid-sentence, one hand open in a natural explanatory motion, animated engaged expression',
  'standing squarely, one hand loosely in a pocket, relaxed open shoulders, calm steady eye contact',
  'three-quarter profile, gaze off-frame, one hand gesturing outward presenting, thoughtful expression',
  'leaning slightly toward camera, one open hand offering gesture near chest, subtle confident smile',
  'both hands lightly framing an idea at chest height, eyebrows raised, enthusiastic expression',
]
const THEME_OUTFITS = {
  modern: 'a clean well-fitted plain crew-neck t-shirt in a neutral tone',
  bold: 'a sharp fitted solid-color t-shirt',
  edgy: 'a fitted dark tee or casual jacket with a street edge',
  cursive: 'refined smart-casual attire, a fitted knit or light shirt',
  futuristic: 'a sleek modern top or minimal technical jacket',
  minimal: 'a plain premium crew-neck tee in a muted tone',
  retro: 'a casual vintage-styled top',
}
function resolveOutfit(theme, userOutfit) {
  return String(userOutfit || '').trim() || THEME_OUTFITS[theme] || 'a clean, well-fitted outfit that suits the visual style'
}

// ── Templates ──────────────────────────────────────────────────────────
// A TEMPLATE is a complete locked design system extracted from an approved
// real carousel. Selecting one swaps the person for the user's likeness (via
// their reference photo), the accent color for their brand color, and the
// copy for their own — everything else about the look is frozen.
const TEMPLATES = {
  editorial: {
    // Ray's "5 content ideas" set: cream editorial, charcoal type, accent
    // knockout boxes, high-contrast B&W portrait blended into the cream.
    style: 'Premium editorial magazine look. Clean solid off-white cream background (a warm paper white, #f5f0e8), generous negative space, calm and expensive. The person is a high-contrast BLACK AND WHITE photograph blended directly into the cream background with soft edges (no photo box, no frame).',
    portraitBW: true,
    knockout: true,       // accent words boxed in accent color, text knocked out in cream
    ink: 'dark',
    knockText: '#f5f0e8', // knocked-out letters match the cream background
    accentFallback: '#d43a2f',
    outfit: 'a plain fitted crew-neck t-shirt (reads light or dark in black and white)',
  },
}

// ── Background presets ─────────────────────────────────────────────────
// Solid / gradient / texture backdrops. The UI shows one fixed example of
// each; at generation time ${primary}/${secondary} are swapped for the
// brand's colors, unless the user names specific colors in their style notes
// (the prompt tells the model those override the palette).
const BACKGROUND_PRESETS = {
  'solid-light': 'a clean solid light background, a very soft pale tint of ${primary}',
  'solid-dark': 'a deep solid dark background subtly tinted with ${primary}',
  'solid-brand': 'a rich solid background in ${primary}',
  'gradient-soft': 'a smooth soft vertical gradient from a light tint of ${primary} at the top into near-white at the bottom',
  'gradient-bold': 'a rich saturated diagonal gradient from ${primary} to ${secondary}',
  'gradient-glow': 'a near-black background with a soft radial glow of ${primary} rising from the bottom center',
  'texture-paper': 'a warm subtly textured paper background with a faint tint of ${primary}',
  'texture-grain': 'a dark moody background with fine film grain and a soft ${primary} light leak from one corner',
  'texture-grid': 'a dark background with a faint receding perspective grid and a ${primary} accent glow',
  'texture-marble': 'an elegant light marble background with delicate veins, subtly tinted toward ${primary}',
}
function resolveBackground(key, brandColors) {
  const tpl = BACKGROUND_PRESETS[key]
  if (!tpl) return ''
  const [primary, secondary] = String(brandColors || '').split(' and ').map((s) => s.trim()).filter(Boolean)
  return tpl
    .replaceAll('${primary}', primary || 'a deep slate blue')
    .replaceAll('${secondary}', secondary || primary || 'a warm neutral')
}

async function planCarousel({ topic, slideCount, brandMd, format, person }) {
  const out = await anthropicMessage({
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    system: [
      'You plan the COPY for a short-form social CAROUSEL (multi-slide photo post) for a brand. You do NOT design visuals.',
      'Return ONLY valid JSON, no preamble, matching exactly:',
      `{ "title": string, "caption": string, "hashtags": string, "slides": [ { "kind": "cover"|"tip"|"cta", "headline": string, "body": string, "accent": string${person ? ', "pose": string' : ', "focal": string'} } ] }`,
      '',
      `Produce EXACTLY ${slideCount} slides: slide 1 kind "cover", the last slide kind "cta", the rest "tip".`,
      FORMAT_GUIDES[format] ? `STRUCTURE: ${FORMAT_GUIDES[format]}` : '',
      'headline: punchy, <= 8 words. body: for "tip" slides write 2 to 4 short sentences (about 25 to 55 words) that actually teach the point, in 1 or 2 tiny paragraphs; for "cover" a single 1-line promise; for "cta" a short 1 to 2 sentence nudge. Never leave a tip body empty.',
      'accent: 1 to 3 words taken VERBATIM from THIS slide\'s headline (an exact substring, same casing as written) to emphasize in the brand accent color. Pick the punchiest keyword(s). Leave "" only if nothing should be emphasized.',
      person
        ? 'pose: a short description of how the featured PERSON stands/gestures/expresses on THIS slide. VARY it every slide. Describe ONLY pose and expression, never their face, identity, clothing, or the background.'
        : 'focal: OPTIONAL short description of one supporting visual element unique to this slide that sits inside the shared background. Leave "" if the slide is just text. Do NOT describe the background itself.',
      'caption: a scroll-stopping caption for the whole carousel (<= 400 chars). hashtags: at most 5, space-separated, each starting with #.',
      'NO em dashes anywhere. Use periods, commas, or "to" for ranges.',
      brandMd ? `\nBrand context:\n${brandMd}` : '',
    ].filter(Boolean).join('\n'),
    messages: [{ role: 'user', content: `Topic: ${topic}` }],
  })
  let text = (out?.content || []).map((c) => c?.text || '').join('').trim()
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const start = text.indexOf('{'); const end = text.lastIndexOf('}') + 1
  if (start < 0 || end <= start) throw new Error('Planner returned no JSON')
  let jsonStr = text.slice(start, end)
  let plan
  try { plan = JSON.parse(jsonStr) }
  catch {
    try { plan = JSON.parse(jsonStr.replace(/,(\s*[}\]])/g, '$1')) }
    catch { throw new Error('Could not parse the slide plan. Try again or reduce the slide count.') }
  }
  if (!Array.isArray(plan?.slides) || !plan.slides.length) throw new Error('Planner returned no slides')
  return plan
}

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

async function refHasPerson(refUrl) {
  try {
    const out = await anthropicMessage({
      model: 'claude-sonnet-5', max_tokens: 5,
      system: 'Answer with a single word: "yes" if the image clearly contains a real human person (a face or body), otherwise "no".',
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'url', url: refUrl } },
        { type: 'text', text: 'Does this image contain a person?' },
      ] }],
    })
    const t = (out?.content || []).map((c) => c?.text || '').join('').trim().toLowerCase()
    return t.startsWith('y')
  } catch { return false }
}

async function describeSubject(refUrl) {
  try {
    const out = await anthropicMessage({
      model: 'claude-sonnet-5', max_tokens: 400,
      system: [
        'You write a locked identity description of a person for consistent AI portrait regeneration.',
        'In 90 to 140 words, describe ONLY their fixed identity: face shape, skin tone, eye and eyebrow shape, nose, lips, facial hair, hairstyle, approximate age range, build, and any permanent distinguishing features.',
        'Do NOT mention clothing, background, pose, expression, lighting, camera, or that it is a photo. Output one plain descriptive paragraph, no preamble.',
      ].join(' '),
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'url', url: refUrl } },
        { type: 'text', text: 'Describe this person.' },
      ] }],
    })
    const desc = (out?.content || []).map((c) => c?.text || '').join('').trim()
    if (!desc) return ''
    return `SUBJECT: This is the exact same person shown in the reference photos. ${desc} Preserve this precise facial identity, bone structure, skin tone, hairstyle and facial hair with no drift, as if photographed on the same day. Both hands (if shown) anatomically correct and complete with five fingers each.`
  } catch { return '' }
}

function buildStyle({ themeStyle, brandColors, extraStyle, background, template }) {
  // A template is a complete locked look — it replaces theme + palette + the
  // "rich background" directive entirely (only the accent color is swapped).
  if (template) {
    return [template.style, extraStyle || ''].filter(Boolean).join(' ')
  }
  return [
    themeStyle || 'Clean modern editorial design.',
    background ? `BACKGROUND (use this exact backdrop on every slide): ${background}.` : '',
    brandColors ? `Palette built around the brand colors ${brandColors}.` : 'One cohesive, restrained palette.',
    extraStyle ? `${extraStyle}. If these notes name specific colors, they OVERRIDE the palette above.` : '',
    'High production value, strong visual hierarchy, premium social-media carousel aesthetic.',
    background ? '' : 'Rich designed background, not a flat empty color.',
  ].filter(Boolean).join(' ')
}
function slideLayout({ person, focal }) {
  const parts = []
  if (person) {
    parts.push('Feature the person LARGE on the RIGHT, shown head to about the waist, roughly 55 to 62 percent of the frame width, bleeding off the right and bottom edges so they occupy real space. Use the provided portrait EXACTLY as-is (do not change their face, hair, skin, build or pose). Blend them into the background with matched lighting and a natural contact shadow so they look genuinely photographed in the scene, NOT a flat cutout pasted on top (no hard sticker edge, no floating, no white halo). Leave the entire LEFT ~48 percent of the frame as clean, relatively empty background reserved for text added later.')
  } else {
    parts.push('Keep the TOP-LEFT ~55 percent of the frame as clean, relatively empty background reserved for text added later.')
    parts.push(focal ? `Place this supporting visual in the lower or right portion of the frame: ${focal}.` : 'Keep the composition clean and uncluttered.')
  }
  parts.push('CRITICAL: render absolutely NO text, letters, words, headlines, captions, labels, numbers, watermark, page number or slide number ANYWHERE in the image. The image is a background/subject only, text is added afterward.')
  return parts.join(' ')
}
function coverPrompt({ style, person, focal }) {
  return `Design the VISUAL for a vertical 3:4 social media carousel COVER slide from scratch (background and subject only, no text). STYLE: ${style}\n\n${slideLayout({ person, focal })}`
}
function followPrompt({ style, person, focal }) {
  const roles = person
    ? 'Reference image 1 is the STYLE ANCHOR: reproduce its EXACT background, colors, lighting and design system so this slide looks like the same series. Reference image 2 is the PORTRAIT of the person to feature.'
    : 'The provided reference image is the STYLE ANCHOR: reproduce its EXACT background, colors, lighting and design system so this slide looks like the same series.'
  return `Design the VISUAL for another slide in the SAME carousel series (background and subject only, no text). ${roles} Do NOT copy the anchor's foreground subject. STYLE: ${style}\n\n${slideLayout({ person, focal })}`
}
function portraitPrompt({ subject, outfit, pose, bw }) {
  return [
    subject || 'SUBJECT: the exact same person shown in the reference photos, preserve their precise facial identity, hair, build and skin tone with no drift.',
    `WARDROBE: they are wearing ${outfit}. Keep this outfit identical in every image.`,
    `POSE: ${pose || DEFAULT_POSES[0]}.`,
    bw ? `${CAMERA} Converted to rich HIGH-CONTRAST BLACK AND WHITE with clean tonal separation and gentle highlight roll-off.` : CAMERA,
    'Show them from the head to about the waist, upper body and torso clearly visible. The person is isolated on a PURE SOLID WHITE background (#ffffff) with soft edges. No text, no graphics, no props, no border.',
  ].join('\n\n')
}
function genPortrait(req, { profile_id, refs, subject, outfit, pose, bw, aspect }) {
  return genImage(req, { profile_id, prompt: portraitPrompt({ subject, outfit, pose, bw }), model: 'seedream', reference_urls: refs, aspect })
}

// ── The step machine ───────────────────────────────────────────────────
// runStep executes job.step and returns a { ...patch } to merge into the row.
// It mutates a shallow copy of state and returns it so callers persist it.

export async function runStep(req, job) {
  const request = job.request || {}
  const state = { ...(job.state || {}) }
  const profile_id = job.profile_id
  const aspect = request.aspect || '3:4'

  if (job.step === 'plan') {
    const refs = (Array.isArray(request.reference_urls) ? request.reference_urls.filter(Boolean) : [])
    const themeStyle = THEME_PROMPTS[request.theme] || ''
    const extraStyle = String(request.extra_style || '').trim()
    const person = refs.length > 0 && await refHasPerson(refs[0])

    let brandMd = '', brandColors = '', profRow = null
    try {
      brandMd = renderBrandContextMarkdown(await loadBrandContext(profile_id), { exclude: ['exemplars'] })
      const pr = await supaFetch(`profiles?id=eq.${profile_id}&select=brand_color,brand_color_secondary,owner_name,business_name,instagram_handle,tiktok_handle,threads_handle,youtube_handle,x_handle`)
      profRow = pr?.[0] || null
      brandColors = [profRow?.brand_color, profRow?.brand_color_secondary].filter(Boolean).join(' and ')
    } catch { /* brandless */ }

    const sig = (() => {
      const signature = request.signature
      if (signature && signature.enabled === false) return null
      const name = String(signature?.name || profRow?.owner_name || profRow?.business_name || '').trim()
      const handle = String(signature?.handle || profRow?.instagram_handle || profRow?.tiktok_handle || profRow?.threads_handle || profRow?.youtube_handle || profRow?.x_handle || '').trim()
      if (!name && !handle) return null
      return { name, handle, dark: signature?.dark !== false }
    })()

    const n = Math.max(3, Math.min(8, Number(request.slide_count) || 6))
    const plan = await planCarousel({ topic: request.topic, slideCount: n, brandMd, format: request.format, person })
    const slides = plan.slides.slice(0, n)

    // Template (a full locked look) beats theme + background preset.
    const template = TEMPLATES[request.template] || null
    const background = template ? '' : resolveBackground(request.background, brandColors)

    Object.assign(state, {
      // Templates force their display face (bold = Anton, the knockout look).
      refs, person, n, theme: template ? 'bold' : request.theme,
      style: buildStyle({ themeStyle, brandColors, extraStyle, background, template }),
      outfit: person ? (String(request.outfit || '').trim() || template?.outfit || resolveOutfit(request.theme, request.outfit)) : '',
      subject: person ? await describeSubject(refs[0]) : '',
      ink: template ? template.ink
        : (request.signature && typeof request.signature.dark === 'boolean')
          ? (request.signature.dark ? 'dark' : 'light') : (THEME_INK[request.theme] || 'dark'),
      accentColor: profRow?.brand_color || template?.accentFallback || '#ff3b30',
      knockout: !!template?.knockout,
      knockText: template?.knockText || '#f5f0e8',
      portraitBW: !!template?.portraitBW,
      sig,
      plan: { title: plan.title, caption: plan.caption, hashtags: plan.hashtags, slides },
      raw: [],
    })
    return { step: 'cover', stage: 'Designing the cover', status: 'working', state, progress: 8 }
  }

  const { style, person, n, refs, plan } = state
  const slides = plan.slides
  const raw = Array.isArray(state.raw) ? state.raw.slice() : []
  const poseAt = (i) => (person ? (String(slides[i]?.pose || '').trim() || DEFAULT_POSES[i % DEFAULT_POSES.length]) : '')
  const focalAt = (i) => (person ? '' : String(slides[i]?.focal || '').trim())

  if (job.step === 'cover') {
    if (!raw[0]) {
      raw[0] = person
        ? await genImage(req, { profile_id, prompt: coverPrompt({ style, person: true, focal: '' }), model: 'gpt-2', reference_urls: [await genPortrait(req, { profile_id, refs, subject: state.subject, outfit: state.outfit, pose: poseAt(0), bw: state.portraitBW, aspect })], aspect })
        : await genImage(req, { profile_id, prompt: coverPrompt({ style, person: false, focal: focalAt(0) }), model: 'gpt-2', reference_urls: refs.length ? refs : undefined, aspect })
    }
    state.raw = raw
    const next = n > 1 ? 'slide' : 'composite'
    return { step: next, stage: n > 1 ? 'Rendering slide 2' : 'Adding text', status: 'working', state, cursor: 1, progress: Math.round(8 + (1 / n) * 72) }
  }

  if (job.step === 'slide') {
    const i = Math.max(1, Number(job.cursor) || 1)
    if (!raw[i]) {
      raw[i] = person
        ? await genImage(req, { profile_id, prompt: followPrompt({ style, person: true, focal: '' }), model: 'gpt-2', reference_urls: [raw[0], await genPortrait(req, { profile_id, refs, subject: state.subject, outfit: state.outfit, pose: poseAt(i), bw: state.portraitBW, aspect })], aspect })
        : await genImage(req, { profile_id, prompt: followPrompt({ style, person: false, focal: focalAt(i) }), model: 'gpt-2', reference_urls: [raw[0], ...refs], aspect })
    }
    state.raw = raw
    const nextI = i + 1
    if (nextI >= n) return { step: 'composite', stage: 'Adding text', status: 'working', state, progress: 84 }
    return { step: 'slide', stage: `Rendering slide ${nextI + 1}`, status: 'working', state, cursor: nextI, progress: Math.round(8 + (nextI / n) * 72) }
  }

  if (job.step === 'composite') {
    let urls = raw.slice(0, n)
    urls = await Promise.all(urls.map((u, i) => compositeSlideText(u, {
      headline: slides[i]?.headline, body: slides[i]?.body, accent: slides[i]?.accent,
      theme: state.theme, ink: state.ink, accentColor: state.accentColor, person, profileId: profile_id,
      knockout: !!state.knockout, knockText: state.knockText,
    })))
    if (state.sig) urls = await Promise.all(urls.map((u) => compositeLockup(u, { ...state.sig, profileId: profile_id })))

    const title = String(plan.title || request.topic).slice(0, 120)
    const caption = String(plan.caption || '').slice(0, 5000)
    const hashtags = capHashtags(plan.hashtags, 5)
    const inserted = await supaFetch('content_scripts', {
      method: 'POST', prefer: 'return=representation',
      body: { profile_id, title, caption, hashtags, media_urls: urls, media_type: 'carousel', post_type: 'post', status: 'draft', generated_by: 'carousel-builder' },
    })
    const row = Array.isArray(inserted) ? inserted[0] : inserted
    return { step: 'done', stage: 'Done', status: 'done', images: urls, content_id: row?.id || null, title, caption, hashtags, progress: 100, state }
  }

  return { status: job.status, step: job.step }
}
