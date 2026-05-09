// POST /api/images/generate
// Body: { profile_id, prompt, model?, count?, aspect?, quality?, reference_urls? }
// Returns: { images: [{ url }] }
//
// Wraps KIE.ai image generation. KIE uses a unified jobs API:
//   POST /api/v1/jobs/createTask  body: { model, input: { ... } }
//   GET  /api/v1/jobs/recordInfo?taskId=…
// Response shape: { code, msg, data: { taskId } } / { data: { state, resultJson, ... } }
// resultJson is a JSON-encoded STRING that needs to be parsed.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { message as anthropicMessage } from '../_lib/anthropic.js'

// Reference-role expansion. Always runs when the prompt has any
// `reference "..."` mentions. A small Claude call classifies each
// reference's role (person / outfit / background / object) from the
// surrounding context and rewrites the body with explicit
// attribute-extraction language for each. This is what makes prompts
// like "image of woman in @image1 wearing outfit in @image2" actually
// route attributes correctly across multiple refs without the user
// writing the boilerplate. Falls through to the original prompt on
// any error so an Anthropic hiccup never blocks the render.
async function expandReferenceRoles(rawPrompt) {
  if (!/reference\s+"[^"]+"/i.test(rawPrompt)) return rawPrompt
  try {
    const out = await anthropicMessage({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: [
        'You expand image-generation prompts that reference labeled images.',
        'For each `reference "X"` mention in the body of the prompt, classify what role the reference plays (PERSON / OUTFIT / BACKGROUND / OBJECT) and EXPAND the prompt with the matching attribute-extraction language.',
        '',
        'Roles and their expansion language:',
        '',
        'PERSON (the reference is being used to define a person/subject):',
        '  Add: "Keep [her/his/their] exact face, eyes, nose, mouth, eyebrows, jawline, hairline, hair length and style, skin tone, body shape, height, and proportions identical to reference \\"X\\". Do not change the face or proportions."',
        '',
        'OUTFIT (the reference is being used to define clothing or styling):',
        '  Add: "Use ONLY the clothing, accessories, and styling from reference \\"X\\". Do not copy the face, body, hair, or background from reference \\"X\\"."',
        '',
        'BACKGROUND / SCENE (the reference is being used as the setting or environment):',
        '  Add: "Use the background, lighting, and environment from reference \\"X\\". Do not copy any people, faces, or text overlays from reference \\"X\\"."',
        '',
        'OBJECT / PROP (the reference is being used for a specific object, logo, product, or prop):',
        '  Add: "Place the [object] from reference \\"X\\" naturally in the scene. Use only that object, not other elements from reference \\"X\\"."',
        '',
        'Disambiguation:',
        '• If the user has already written explicit role/extraction language for a given reference (e.g. "keep her face from reference X" or "use only the clothing from reference Y"), keep their language as-is. Do not re-expand that reference.',
        '• If the role of a reference is ambiguous, treat it as PERSON.',
        '• Use natural pronouns when the subject\'s gender is implied by the prompt ("woman" → her, "man" → his, otherwise use "their").',
        '',
        'Block preservation:',
        '• If a "BRAND IDENTITY DIRECTIVE" or "REFERENCE DIRECTIVE" block is present at the top of the prompt (followed by a "---" separator), keep that block VERBATIM. Do not paraphrase, reformat, or remove any line. Only expand the body that follows the separator.',
        '',
        'Output: the full rewritten prompt only. No preamble, no quotes, no explanation.',
      ].join('\n'),
      messages: [{ role: 'user', content: rawPrompt }],
    })
    const text = (out?.content || []).map((c) => c?.text || '').join('').trim()
    return text || rawPrompt
  } catch {
    return rawPrompt
  }
}

// Optional prompt enhancement — Claude rewrites the user's bare prompt with
// composition, lighting, and brand cues so the image model has more to work
// with. Falls through to the original prompt on any error so a transient
// Anthropic hiccup never blocks the actual render.
async function enhancePrompt(rawPrompt) {
  try {
    const out = await anthropicMessage({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system:
        'You rewrite short user prompts into vivid image-generation prompts. Output ONLY the rewritten prompt, no preamble, no quotes. ' +
        'Preserve every concrete detail the user gave (subject, brand, palette, references). Add: composition, camera angle, lighting, mood, ' +
        'background detail, render style. ' +
        'If a "BRAND IDENTITY DIRECTIVE" or "REFERENCE DIRECTIVE" block is present, keep it verbatim at the top (do not paraphrase, reformat, or remove any line) and only enhance the body that follows the "---" separator. ' +
        'Never strip out instructions about not copying watermarks, signatures, or text overlays from references.',
      messages: [{ role: 'user', content: rawPrompt }],
    })
    const text = (out?.content || []).map((c) => c?.text || '').join('').trim()
    return text || rawPrompt
  } catch {
    return rawPrompt
  }
}

// Resolve the UI's friendly model id to the actual KIE model slug, honoring
// reference images by routing GPT to its image-to-image variant when refs
// are present. Each family has a different input shape (see buildInput).
function resolveKieModel(uiModel, hasRefs) {
  switch (uiModel) {
    // Nano Banana family — supports image_input on both 2 and Pro, so the
    // same model id is used regardless of refs.
    case 'nano-banana-2':
    case 'nano-banana':                 // legacy alias
      return 'nano-banana-2'
    case 'nano-banana-pro':
    case 'flux-pro':                    // legacy alias (treat as Pro)
    case 'flux-kontext':                // legacy alias
      return 'nano-banana-pro'

    // GPT image — split endpoints for text-to-image and image-to-image.
    case 'gpt-2':
    case 'gpt-image':                   // legacy alias
      return hasRefs ? 'gpt-image-2-image-to-image' : 'gpt-image-2-text-to-image'

    default:
      // Unknown id — best guess: assume KIE accepts it as-is.
      return uiModel
  }
}

// KIE input shapes vary per model. Build the right one.
function buildInput(kieModel, { prompt, aspect, count, quality, reference_urls }) {
  const refs = Array.isArray(reference_urls) ? reference_urls.filter(Boolean) : []
  const numImages = Math.max(1, Math.min(8, Number(count) || 1))
  const aspect_ratio = aspect || 'auto'

  if (kieModel === 'nano-banana-2' || kieModel === 'nano-banana-pro') {
    return {
      prompt,
      image_input: refs,            // empty array is fine for text-to-image
      aspect_ratio,
      resolution: quality || '1K',
      output_format: 'png',
      num_images: numImages,
    }
  }
  if (kieModel === 'gpt-image-2-image-to-image') {
    return {
      prompt,
      input_urls: refs,
      aspect_ratio,
      num_images: numImages,
    }
  }
  if (kieModel === 'gpt-image-2-text-to-image') {
    return {
      prompt,
      aspect_ratio,
      num_images: numImages,
    }
  }
  // Generic fallback — set every common field so an unknown model has a
  // chance of accepting at least one of them.
  const base = {
    prompt,
    aspect_ratio,
    image_size: aspect_ratio,
    resolution: quality || '1K',
    output_format: 'png',
    num_images: numImages,
  }
  if (refs.length) {
    base.image_input = refs
    base.input_urls = refs
    base.image_urls = refs
    base.image_url = refs.length === 1 ? refs[0] : refs
  }
  return base
}

function pickError(body, fallbackStatus) {
  // KIE may return any of: msg, message, error.message, error, code+msg
  const msg = body?.msg || body?.message || body?.error?.message || body?.error || ''
  const code = body?.code != null ? ` (code ${body.code})` : ''
  return msg ? `${msg}${code}` : `KIE error ${fallbackStatus}${code}`
}

function parseResultUrls(data) {
  // resultJson is a JSON-string of { resultUrls: [...] }
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
    out = data?.resultUrls || data?.result?.urls || data?.images?.map?.((i) => i.url || i) || []
  }
  return (Array.isArray(out) ? out : []).filter(Boolean)
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const {
      profile_id,
      prompt,
      model = 'nano-banana',
      count = 1,
      aspect = '1:1',
      quality,
      reference_urls,
      enhance_prompt = false,
    } = req.body || {}
    if (!profile_id || !prompt) return res.status(400).json({ error: 'profile_id + prompt required' })
    await assertProfileAccess(auth.user.id, profile_id)

    // Two-stage rewrite. expandReferenceRoles ALWAYS runs when the prompt
    // mentions any `reference "X"` label; it classifies each ref's role
    // (person/outfit/background/object) from context and injects the
    // matching attribute-extraction language. enhancePrompt is the
    // optional aesthetic/composition pass on top.
    const promptWithRoles = await expandReferenceRoles(String(prompt))
    const finalPrompt = enhance_prompt ? await enhancePrompt(promptWithRoles) : promptWithRoles

    const apiKey = process.env.KIE_API_KEY
    if (!apiKey) return res.status(500).json({ error: 'KIE_API_KEY not configured. Add it in Vercel env.' })

    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    if (customerId) {
      const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`)
      const need = 4000 * Math.max(1, Number(count) || 1)
      if ((Number(pools?.[0]?.balance ?? 0)) < need) {
        return res.status(402).json({ error: 'Insufficient AI tokens for image generation.', code: 'insufficient_credits' })
      }
    }

    const hasRefs = Array.isArray(reference_urls) && reference_urls.length > 0
    const kieModel = resolveKieModel(model || 'nano-banana-2', hasRefs)
    const input = buildInput(kieModel, { prompt: finalPrompt, aspect, count, quality, reference_urls })

    // Submit task via the unified jobs endpoint
    const submitResp = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: kieModel, input }),
    })
    const submitText = await submitResp.text()
    let submit = {}
    try { submit = JSON.parse(submitText) } catch { submit = { raw: submitText } }
    if (!submitResp.ok || (submit?.code && submit.code !== 200)) {
      return res.status(502).json({
        error: pickError(submit, submitResp.status),
        kie_status: submitResp.status,
        kie_body: submit,
      })
    }
    const taskId = submit?.data?.taskId || submit?.data?.task_id || submit?.taskId
    if (!taskId) {
      return res.status(502).json({ error: 'KIE returned no taskId', kie_body: submit })
    }

    // Debit credits up front (KIE submission was accepted). If the task
    // later fails the cost is small relative to the round trip latency,
    // and this avoids us holding the connection open for 60-180s.
    if (customerId) {
      try {
        await supaFetch('rpc/consume_credits', {
          method: 'POST',
          body: {
            p_customer_id: customerId,
            p_pool_type: 'ai_tokens',
            p_amount: 4000 * Math.max(1, Number(count) || 1),
            p_action: 'consume:image-gen',
            p_profile_id: profile_id,
            p_metadata: { model: kieModel, aspect, count, prompt: String(prompt).slice(0, 200), taskId },
          },
        })
      } catch {}
    }

    // Return the taskId immediately. The client polls /api/images/status
    // until the job completes — keeps us under Vercel's serverless timeout.
    return res.status(202).json({ taskId, model: kieModel })

  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
