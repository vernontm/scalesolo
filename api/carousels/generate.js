// POST /api/carousels/generate
// Body: { profile_id, topic, slide_count?, reference_urls?, theme?, extra_style?, outfit?, format?, signature?, model?, aspect? }
// Returns: { content_id, title, caption, hashtags, images: [url,...] }
//
// Streamlined carousel builder. Claude drafts a slide plan in the brand's
// voice and chosen visual THEME, each slide is rendered as a branded graphic
// via the existing credit-gated image pipeline (reused in-process so
// billing/refunds are handled there), optionally incorporating uploaded
// REFERENCE images (people, logos, products), and the finished slides are
// assembled into ONE captioned carousel draft in the calendar backlog.
// Images bill the caller's ScaleSolo credits (~4,000 ai_tokens/slide).

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { message as anthropicMessage } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'
import { invokeHandler } from '../_lib/internal-invoke.js'
import { capHashtags } from '../_lib/hashtags.js'
import { compositeLockup } from '../_lib/carousel-lockup.js'
import { compositeSlideText } from '../_lib/carousel-text.js'
import imagesGenerate from '../images/generate.js'
import imagesStatus from '../images/status.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Preset visual themes → the design language injected into every slide's
// image prompt. Keys match the builder's theme chips.
const THEME_PROMPTS = {
  modern: 'Clean modern editorial design, crisp geometric sans-serif type, generous negative space, refined and premium.',
  bold: 'Bold high-impact design, heavy oversized uppercase sans-serif headlines, strong color blocking, punchy and confident.',
  edgy: 'Rough edgy street aesthetic, distressed grunge textures, gritty high-contrast, torn and spray-paint accents, raw energy.',
  cursive: 'Elegant flowing script and cursive headlines paired with a clean supporting sans, refined, luxurious, hand-lettered feel.',
  futuristic: 'Futuristic sci-fi aesthetic, sleek techno typography, neon glow, glassmorphism panels, HUD accents, dark gradient background.',
  minimal: 'Ultra minimal editorial, elegant serif type, muted monochrome palette, lots of whitespace, calm and sophisticated.',
  retro: 'Retro vintage aesthetic, warm nostalgic palette, film grain texture, throwback display typography.',
}

// Default text ink per theme (dark backgrounds → light text, and vice versa).
// Only used when the user has not chosen a signature ink.
const THEME_INK = {
  modern: 'dark', bold: 'dark', cursive: 'dark', minimal: 'dark', retro: 'dark',
  edgy: 'light', futuristic: 'light',
}

// Carousel STRUCTURE (how the slides are organized), separate from the visual
// theme. Steers how the planner shapes the middle slides.
const FORMAT_GUIDES = {
  listicle: 'A numbered LISTICLE. The cover promises a count (e.g. "5 X"); each tip slide is ONE numbered item ("1.", "2.", ...) with a short headline + one line.',
  howto: 'A step-by-step HOW-TO / tutorial. Each tip slide is one sequential step ("Step 1", "Step 2", ...) in order.',
  tips: 'Standalone quick TIPS. Each tip slide is one punchy, self-contained tip. No strict numbering required.',
  mythfact: 'MYTH vs FACT. Each tip slide states a common myth then the truth ("Myth: ... / Truth: ...").',
  story: 'A STORY arc that builds. Cover hooks, tip slides advance a narrative or mini case study, last slide lands the lesson + CTA.',
  checklist: 'A screenshot-worthy CHECKLIST. Each tip slide is one checklist item with a check-style bullet.',
  questions: 'Common QUESTIONS answered. Each tip slide poses one question as the headline and answers it in the body.',
}

// Draft the WORDS for the carousel: title, caption, hashtags, and per-slide
// copy. Deliberately NOT the visual design. Everything visual (background,
// palette, layout, person placement) is a LOCKED scene assembled in code and
// reused byte-identical on every slide, so the only things that change slide
// to slide are the copy and (in person mode) the pose. This is what makes a
// set of separately-generated images read as one cohesive series.
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
        ? 'pose: a short description of how the featured PERSON stands/gestures/expresses on THIS slide. VARY it every slide (e.g. "arms crossed, confident direct eye contact", "mid-gesture explaining, three-quarter turn", "one hand in pocket, relaxed"). Describe ONLY pose and expression, never their face, identity, clothing, or the background.'
        : 'focal: OPTIONAL short description of one supporting visual element unique to this slide that sits inside the shared background (e.g. "a glowing app dashboard mockup", "three stacked cards"). Leave it an empty string "" if the slide is just text. Do NOT describe the background itself, it is fixed for the whole set.',
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

// One credit-gated image generation via the reused image endpoints (billing +
// refunds handled there). Returns the finished (mirrored) URL. Throws on
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

// ── Consistency model ──────────────────────────────────────────────────
// Design philosophy (from the house RayvaughnCEO pipeline): FREEZE every
// axis that defines the look, expose only POSE and COPY. A set of separately
// generated images reads as one cohesive series because ~95% of every prompt
// is byte-identical across slides. Here the frozen axes are:
//   - IDENTITY: the same reference photo(s) + one locked SUBJECT paragraph
//   - WARDROBE: one locked OUTFIT string (theme-derived or user-described)
//   - CAMERA/realism: one fixed block
//   - SCENE (background, palette, layout, person placement): one locked block
// and the only per-slide variables are POSE (person body language) and the
// slide COPY. Two stages: Seedream 5 Pro locks likeness onto the pose, then
// GPT Image 2 composes that portrait into the frozen scene with the copy.

// Fixed realism block — identical on every portrait call.
const CAMERA = (
  'Photorealistic studio portrait, 85mm lens look, soft directional key light with gentle fill, '
  + 'natural visible skin texture and pores, sharp DSLR realism, subtle natural imperfections. '
  + 'NOT CGI, not 3D-rendered, not a digital painting, not airbrushed or plastic.'
)

// Fallback pose rotation (used when the planner does not supply a pose).
const DEFAULT_POSES = [
  'arms crossed loosely across the chest, shoulders squared, chin slightly lifted, direct confident eye contact',
  'three-quarter turn, one hand raised near chest in a precision pinch gesture, focused instructive expression',
  'mid-gesture mid-sentence, one hand open in a natural explanatory motion, animated engaged expression',
  'standing squarely, one hand loosely in a pocket, relaxed open shoulders, calm steady eye contact',
  'three-quarter profile, gaze off-frame, one hand gesturing outward presenting, thoughtful expression',
  'leaning slightly toward camera, one open hand offering gesture near chest, subtle confident smile',
  'both hands lightly framing an idea at chest height, eyebrows raised, enthusiastic expression',
]

// Default wardrobe per theme (used when the user does not describe an outfit).
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

// Cheap vision check: does the first reference photo contain a real person?
async function refHasPerson(refUrl) {
  try {
    const out = await anthropicMessage({
      model: 'claude-sonnet-5',
      max_tokens: 5,
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

// Vision pass, run ONCE per carousel: describe the person's fixed identity so
// the same locked paragraph rides every Seedream call (like the house `S`).
async function describeSubject(refUrl) {
  try {
    const out = await anthropicMessage({
      model: 'claude-sonnet-5',
      max_tokens: 400,
      system: [
        'You write a locked identity description of a person for consistent AI portrait regeneration.',
        'In 90 to 140 words, describe ONLY their fixed identity: face shape, skin tone, eye and eyebrow shape, nose, lips, facial hair, hairstyle (length, texture, how it is worn), approximate age range, build, and any permanent distinguishing features (glasses, moles).',
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

// The shared STYLE directive (theme + palette + extra). Included on the cover
// (designed from scratch) and reinforced on every follower slide alongside the
// cover image itself.
function buildStyle({ themeStyle, brandColors, extraStyle }) {
  return [
    themeStyle || 'Clean modern editorial design.',
    brandColors ? `Palette built around the brand colors ${brandColors}.` : 'One cohesive, restrained palette.',
    extraStyle || '',
    'High production value, strong visual hierarchy, premium social-media carousel aesthetic. Rich designed background, not a flat empty color.',
  ].filter(Boolean).join(' ')
}

// Shared VISUAL layout wording. The headline + body are NOT rendered by the
// image model (they are composited later with locked typography), so every
// prompt forbids text and reserves the text zone. Byte-identical across slides.
function slideLayout({ person, focal }) {
  const parts = []
  if (person) {
    parts.push('Feature the person LARGE on the RIGHT, shown head to about the waist, roughly 55 to 62 percent of the frame width, bleeding off the right and bottom edges so they occupy real space. Use the provided portrait EXACTLY as-is (do not change their face, hair, skin, build or pose). Blend them into the background with matched lighting and a natural contact shadow so they look genuinely photographed in the scene, NOT a flat cutout pasted on top (no hard sticker edge, no floating, no white halo). Leave the entire LEFT ~48 percent of the frame as clean, relatively empty background (only the background shows there) reserved for text added later.')
  } else {
    parts.push('Keep the TOP-LEFT ~55 percent of the frame as clean, relatively empty background reserved for text added later.')
    parts.push(focal ? `Place this supporting visual in the lower or right portion of the frame: ${focal}.` : 'Keep the composition clean and uncluttered.')
  }
  parts.push('CRITICAL: render absolutely NO text, letters, words, headlines, captions, labels, numbers, watermark, page number or slide number ANYWHERE in the image. The image is a background/subject only, text is added afterward.')
  return parts.join(' ')
}

// The COVER slide's VISUAL is designed from scratch and becomes the STYLE
// ANCHOR for the whole set. Every other slide reproduces its exact background.
function coverPrompt({ style, person, focal }) {
  return `Design the VISUAL for a vertical 3:4 social media carousel COVER slide from scratch (background and subject only, no text). STYLE: ${style}\n\n${slideLayout({ person, focal })}`
}

// A FOLLOWER slide reproduces the anchor's exact look (handed in as a reference
// image); only the person portrait / focal graphic changes. No text either.
function followPrompt({ style, person, focal }) {
  const roles = person
    ? 'Reference image 1 is the STYLE ANCHOR: reproduce its EXACT background, colors, lighting and design system so this slide looks like the same series. Reference image 2 is the PORTRAIT of the person to feature.'
    : 'The provided reference image is the STYLE ANCHOR: reproduce its EXACT background, colors, lighting and design system so this slide looks like the same series.'
  return `Design the VISUAL for another slide in the SAME carousel series (background and subject only, no text). ${roles} Do NOT copy the anchor's foreground subject. STYLE: ${style}\n\n${slideLayout({ person, focal })}`
}

// Locked portrait prompt: SUBJECT + WARDROBE + per-slide POSE + CAMERA.
function portraitPrompt({ subject, outfit, pose }) {
  return [
    subject || 'SUBJECT: the exact same person shown in the reference photos, preserve their precise facial identity, hair, build and skin tone with no drift.',
    `WARDROBE: they are wearing ${outfit}. Keep this outfit identical in every image.`,
    `POSE: ${pose || DEFAULT_POSES[0]}.`,
    CAMERA,
    'Show them from the head to about the waist, upper body and torso clearly visible. The person is isolated on a PURE SOLID WHITE background (#ffffff) with soft edges. No text, no graphics, no props, no border.',
  ].join('\n\n')
}

// Render a person portrait (Seedream) locking identity + outfit, varying pose.
function genPortrait(originalReq, { profile_id, refs, subject, outfit, pose, aspect }) {
  return genImage(originalReq, {
    profile_id, prompt: portraitPrompt({ subject, outfit, pose }), model: 'seedream',
    reference_urls: refs, aspect,
  })
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, topic, slide_count = 6, reference_urls, theme, extra_style, outfit, format, signature, model, aspect = '3:4' } = req.body || {}
    if (!profile_id || !topic) return res.status(400).json({ error: 'profile_id + topic required' })
    await assertProfileAccess(auth.user.id, profile_id)
    const n = Math.max(3, Math.min(8, Number(slide_count) || 6))
    const refs = (Array.isArray(reference_urls) ? reference_urls.filter(Boolean) : [])
    const themeStyle = THEME_PROMPTS[theme] || ''
    const extraStyle = String(extra_style || '').trim()

    // Auto-detect a PERSON in the references. When present, every slide adds a
    // two-stage step (Seedream portrait → GPT Image 2 graphic) so the person's
    // likeness lands. Logos/products are passed straight through as references.
    const person = refs.length > 0 && await refHasPerson(refs[0])

    let brandMd = '', brandColors = ''
    let profRow = null
    try {
      brandMd = renderBrandContextMarkdown(await loadBrandContext(profile_id), { exclude: ['exemplars'] })
      const pr = await supaFetch(`profiles?id=eq.${profile_id}&select=brand_color,brand_color_secondary,owner_name,business_name,instagram_handle,tiktok_handle,threads_handle,youtube_handle,x_handle`)
      profRow = pr?.[0] || null
      brandColors = [profRow?.brand_color, profRow?.brand_color_secondary].filter(Boolean).join(' and ')
    } catch { /* brandless is fine */ }

    // Signature lockup: on by default. Name + handle come from the request
    // (user override) or fall back to the brand profile. `dark` = true renders
    // a near-black signature (for light slides); false renders white.
    const sig = (() => {
      if (signature && signature.enabled === false) return null
      const name = String(signature?.name || profRow?.owner_name || profRow?.business_name || '').trim()
      const handle = String(
        signature?.handle
        || profRow?.instagram_handle || profRow?.tiktok_handle || profRow?.threads_handle
        || profRow?.youtube_handle || profRow?.x_handle || ''
      ).trim()
      if (!name && !handle) return null
      return { name, handle, dark: signature?.dark !== false }
    })()

    const plan = await planCarousel({ topic, slideCount: n, brandMd, format, person })
    const slides = plan.slides.slice(0, n)

    // Freeze the shared axes ONCE, then reuse them byte-identical per slide.
    const style = buildStyle({ themeStyle, brandColors, extraStyle })
    const outfitLocked = person ? resolveOutfit(theme, outfit) : ''
    const subjectLocked = person ? await describeSubject(refs[0]) : ''
    const poseAt = (i) => (person ? (String(slides[i]?.pose || '').trim() || DEFAULT_POSES[i % DEFAULT_POSES.length]) : '')
    const focalAt = (i) => (person ? '' : String(slides[i]?.focal || '').trim())

    let urls
    try {
      // 1) Design the COVER visual (no text) — it is the style ANCHOR.
      let coverUrl
      if (person) {
        const portrait = await genPortrait(req, { profile_id, refs, subject: subjectLocked, outfit: outfitLocked, pose: poseAt(0), aspect })
        coverUrl = await genImage(req, { profile_id, prompt: coverPrompt({ style, person: true, focal: '' }), model: 'gpt-2', reference_urls: [portrait], aspect })
      } else {
        coverUrl = await genImage(req, { profile_id, prompt: coverPrompt({ style, person: false, focal: focalAt(0) }), model: 'gpt-2', reference_urls: refs.length ? refs : undefined, aspect })
      }

      // 2) Every follower reproduces the anchor's exact look (visual only).
      const rest = await Promise.all(slides.slice(1).map(async (s, idx) => {
        const i = idx + 1
        if (person) {
          const portrait = await genPortrait(req, { profile_id, refs, subject: subjectLocked, outfit: outfitLocked, pose: poseAt(i), aspect })
          return genImage(req, { profile_id, prompt: followPrompt({ style, person: true, focal: '' }), model: 'gpt-2', reference_urls: [coverUrl, portrait], aspect })
        }
        return genImage(req, { profile_id, prompt: followPrompt({ style, person: false, focal: focalAt(i) }), model: 'gpt-2', reference_urls: [coverUrl, ...refs], aspect })
      }))
      urls = [coverUrl, ...rest]
    } catch (e) {
      if (e.code === 'insufficient_credits') {
        const est = 4000 * (n * (person ? 2 : 1))
        return res.status(402).json({ error: `Not enough credits to render ${n} slides (~${est} ai_tokens${person ? ', two stages per slide for the person likeness' : ''}). ${e.message}`, code: 'insufficient_credits' })
      }
      return res.status(502).json({ error: `Slide generation failed: ${e.message}` })
    }

    // Composite the LOCKED headline + body typography onto every slide (same
    // fonts, sizes, weights, tracking and leading on all slides). Accent words
    // pick up the brand color. Best-effort per slide.
    {
      const ink = (signature && typeof signature.dark === 'boolean')
        ? (signature.dark ? 'dark' : 'light')
        : (THEME_INK[theme] || 'dark')
      const accentColor = profRow?.brand_color || '#ff3b30'
      urls = await Promise.all(urls.map((u, i) => compositeSlideText(u, {
        headline: slides[i]?.headline, body: slides[i]?.body, accent: slides[i]?.accent,
        theme, ink, accentColor, person, profileId: profile_id,
      })))
    }

    // Composite the brand name + handle signature onto each slide (best-effort;
    // falls back to the un-signed slide on any failure).
    if (sig) {
      urls = await Promise.all(urls.map((u) => compositeLockup(u, { ...sig, profileId: profile_id })))
    }

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
      title, caption, hashtags, images: urls,
      status: 'draft (in the calendar backlog)',
    })
  } catch (err) {
    if (err?.code === 'insufficient_credits') return res.status(402).json({ error: err.message, code: 'insufficient_credits' })
    return res.status(err.status || 500).json({ error: err.message })
  }
}
