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
    } = req.body || {}
    if (!profile_id || !prompt) return res.status(400).json({ error: 'profile_id + prompt required' })
    await assertProfileAccess(auth.user.id, profile_id)

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
    const input = buildInput(kieModel, { prompt, aspect, count, quality, reference_urls })

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
