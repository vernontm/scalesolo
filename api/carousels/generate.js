// POST /api/carousels/generate
// Body: { profile_id, topic, slide_count?, reference_urls?, theme?, extra_style?, model?, aspect? }
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

// Draft the slide plan + post caption from the topic, in the brand's voice,
// chosen structure (format), and visual style.
async function planCarousel({ topic, slideCount, brandMd, brandColors, style, format, hasRefs, person, sig }) {
  const out = await anthropicMessage({
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    system: [
      'You plan short-form social CAROUSELS (multi-slide photo posts) for a brand.',
      'Return ONLY valid JSON, no preamble, matching exactly:',
      `{ "title": string, "caption": string, "hashtags": string, "slides": [ { "kind": "cover"|"tip"|"cta", "headline": string, "body": string, ${person ? '"pose": string, ' : ''}"image_prompt": string } ] }`,
      '',
      `Produce EXACTLY ${slideCount} slides: slide 1 kind "cover", the last slide kind "cta", the rest "tip".`,
      FORMAT_GUIDES[format] ? `STRUCTURE: ${FORMAT_GUIDES[format]}` : '',
      person ? 'pose: a short description of how the featured PERSON should stand/gesture on THIS slide (vary it slide to slide, e.g. "arms crossed, confident direct eye contact" or "mid-gesture explaining, three-quarter turn"). The person is rendered from a reference photo and placed on the slide, so do NOT describe the person\'s face/clothing/identity, only the pose and expression.' : '',
      'headline: punchy, <= 8 words. body: for "tip" slides write 2 to 4 short sentences (about 25 to 55 words) that actually teach the point, broken into 1 or 2 tiny paragraphs; for "cover" a 1-line promise is fine; for "cta" a short 1 to 2 sentence nudge. Never leave a tip body empty.',
      'image_prompt: a complete prompt for an image model to render a 3:4 branded graphic for THIS slide. It MUST:',
      '  - render BOTH the exact HEADLINE (large, crisp, the visual focal point) AND the full BODY text beneath it, all spelled exactly as given, as clean legible typography with clear hierarchy (big bold headline, smaller readable body paragraph). Layout the body as real sentences/paragraphs, not a caption.',
      '  - lay out headline top, body below it, with comfortable margins so no text is cut off or crowded; body text must be fully legible, not tiny.',
      `  - use the brand's colors${brandColors ? ` (${brandColors})` : ''} and a clean, cohesive layout consistent across all slides`,
      style ? `  - FOLLOW THIS VISUAL STYLE on every slide: ${style}` : '',
      person ? '  - RESERVE about half the frame (one side) as clean empty background for a person portrait that is composited in separately; put the headline and body text on the OPPOSITE side. Do NOT describe or draw any person yourself.'
        : hasRefs ? '  - COMPOSE WITH THE PROVIDED REFERENCE IMAGE(S): place the referenced subject (a logo or product) naturally in the frame; keep its exact form; the headline text must not overlap it.' : '',
      sig ? '  - LEAVE the bottom-left corner clear (a small empty margin, no text or key subject there): a name + handle signature is added afterward. Do NOT render any name, handle, @username, or signature yourself.' : '',
      '  - describe composition/background so the set looks like one designed series',
      '  - NOT include watermarks, other brands\' logos, page numbers, or slide numbers',
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

// ── Person (two-stage) pipeline ────────────────────────────────────────
// When a reference photo contains a person, we mirror the approved house
// pipeline: Seedream 5 Pro renders a photoreal portrait that locks the
// person's likeness onto the requested pose (plain background), then GPT
// Image 2 builds the branded slide graphic AROUND that portrait. One-stage
// image-to-image drifts the face and looks flat; two-stage keeps the
// likeness and the crisp text.

// Generic (any-brand) portrait prompt — honors whoever is in the reference.
function portraitPrompt(pose) {
  return (
    'Photorealistic studio portrait photograph of the SAME person shown in the reference image(s). '
    + 'Preserve their EXACT facial identity, bone structure, skin tone, hairstyle and facial hair with no drift, '
    + 'as if photographed on the same day. '
    + `POSE: ${pose || 'relaxed confident stance, direct eye contact, natural expression'}. `
    + 'Upper body clearly visible, both hands (if shown) anatomically correct with five fingers each. '
    + 'Soft professional lighting, natural visible skin texture, authentic sharp DSLR realism, subtle imperfections. '
    + 'NOT CGI, not 3D-rendered, not a digital painting, not airbrushed or plastic. '
    + 'The person is isolated on a PURE SOLID WHITE background (#ffffff) with soft edges. '
    + 'No text, no graphics, no props, no border.'
  )
}

// Instruction prepended to the slide's graphic prompt for stage 2, telling
// GPT to keep the handed portrait untouched and compose the slide around it.
const COMPOSITE_CLAUSE = (
  'Using the provided portrait photo of the person EXACTLY as-is (do NOT change, redraw or restyle their '
  + 'face, hair, skin, build or pose; keep their exact likeness), build the slide described below. '
  + 'Cleanly remove the plain background behind the person so their figure blends seamlessly into the slide '
  + "background with soft edges (NO photo box, frame or rectangle), placed to ONE side at about 45 to 55% width, "
  + 'bleeding off that edge. Put the headline and ALL body text on the OPPOSITE side with comfortable margins so '
  + 'no text overlaps the person and nothing is cut off. Keep one cohesive layout across the set.\n\nSLIDE: '
)

// Cheap vision check: does the first reference photo contain a real person
// (a visible human face/figure)? Drives whether we run the two-stage path.
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

// Two-stage slide render: Seedream portrait → GPT Image 2 graphic.
async function genPersonSlide(originalReq, { profile_id, refs, pose, graphicPrompt, aspect }) {
  const portrait = await genImage(originalReq, {
    profile_id, prompt: portraitPrompt(pose), model: 'seedream',
    reference_urls: refs, aspect,
  })
  return genImage(originalReq, {
    profile_id, prompt: `${COMPOSITE_CLAUSE}${graphicPrompt}`, model: 'gpt-2',
    reference_urls: [portrait], aspect,
  })
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, topic, slide_count = 6, reference_urls, theme, extra_style, format, signature, model, aspect = '3:4' } = req.body || {}
    if (!profile_id || !topic) return res.status(400).json({ error: 'profile_id + topic required' })
    await assertProfileAccess(auth.user.id, profile_id)
    const n = Math.max(3, Math.min(8, Number(slide_count) || 6))
    const refs = (Array.isArray(reference_urls) ? reference_urls.filter(Boolean) : [])
    // Style directive = preset theme + any free-text the user added.
    const style = [THEME_PROMPTS[theme] || '', String(extra_style || '').trim()].filter(Boolean).join(' ')

    // Auto-detect a PERSON in the references. When present, every slide uses
    // the two-stage house pipeline (Seedream portrait → GPT Image 2 graphic)
    // so the person's likeness lands. Logos/products stay single-stage.
    const person = refs.length > 0 && await refHasPerson(refs[0])
    // Single-stage model (non-person): image-to-image when refs present,
    // else the text-to-image graphic model.
    const useModel = model || (refs.length ? 'gpt-2' : 'nano-banana')

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

    const plan = await planCarousel({ topic, slideCount: n, brandMd, brandColors, style, format, hasRefs: refs.length > 0, person, sig })
    const slides = plan.slides.slice(0, n)

    let urls
    try {
      urls = await Promise.all(slides.map((s) => {
        const graphicPrompt = style ? `${s.image_prompt}\n\nSTYLE: ${style}` : s.image_prompt
        if (person) {
          return genPersonSlide(req, { profile_id, refs, pose: s.pose, graphicPrompt, aspect })
        }
        return genImage(req, { profile_id, prompt: graphicPrompt, model: useModel, reference_urls: refs.length ? refs : undefined, aspect })
      }))
    } catch (e) {
      if (e.code === 'insufficient_credits') {
        const est = 4000 * n * (person ? 2 : 1)
        return res.status(402).json({ error: `Not enough credits to render ${n} slides (~${est} ai_tokens${person ? ', two stages per slide for the person likeness' : ''}). ${e.message}`, code: 'insufficient_credits' })
      }
      return res.status(502).json({ error: `Slide generation failed: ${e.message}` })
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
