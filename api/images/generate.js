// POST /api/images/generate
// Body: { profile_id, prompt, model?, count?, aspect?, quality?, reference_urls? }
// Returns: { images: [{ url }] }
//
// Wraps KIE.ai image generation (Nano Banana, Flux, etc.). Uses their
// async task pattern: createTask → poll recordInfo until success/fail.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'

const SIZE_MAP = {
  '1:1':  '1024x1024',
  '16:9': '1536x864',
  '9:16': '864x1536',
  '4:3':  '1280x960',
  '3:4':  '960x1280',
}

// Map UI model id → KIE endpoint slug. Default to nano-banana.
const MODEL_ENDPOINTS = {
  'nano-banana':   'nano-banana',
  'flux-pro':      'flux/v1.1-pro',
  'flux-kontext':  'flux-kontext',
  'gpt-image':     'gpt4o-image',
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
      quality = '2K',
      reference_urls,
    } = req.body || {}
    if (!profile_id || !prompt) return res.status(400).json({ error: 'profile_id + prompt required' })
    await assertProfileAccess(auth.user.id, profile_id)

    const apiKey = process.env.KIE_API_KEY
    if (!apiKey) return res.status(500).json({ error: 'KIE_API_KEY not configured. Add it in Vercel env.' })

    // Pre-flight credit check (image gen ≈ 4000 ai_tokens equivalent per image)
    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    if (customerId) {
      const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`)
      const need = 4000 * Math.max(1, Number(count) || 1)
      if ((Number(pools?.[0]?.balance ?? 0)) < need) {
        return res.status(402).json({ error: 'Insufficient AI tokens for image generation.', code: 'insufficient_credits' })
      }
    }

    const slug = MODEL_ENDPOINTS[model] || MODEL_ENDPOINTS['nano-banana']
    const size = SIZE_MAP[aspect] || '1024x1024'

    // Submit task
    const submitResp = await fetch(`https://api.kie.ai/api/v1/${slug}/createTask`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        size,
        aspect_ratio: aspect,
        num_images: Math.max(1, Math.min(8, Number(count) || 1)),
        quality,
        ...(Array.isArray(reference_urls) && reference_urls.length ? { image_urls: reference_urls } : {}),
      }),
    })
    const submit = await submitResp.json().catch(() => ({}))
    if (!submitResp.ok) {
      return res.status(502).json({ error: submit?.message || submit?.error || `KIE submit failed (${submitResp.status})`, raw: submit })
    }
    const taskId = submit?.data?.taskId || submit?.taskId || submit?.data?.task_id
    if (!taskId) return res.status(502).json({ error: 'KIE returned no taskId', raw: submit })

    // Poll up to 120s
    const start = Date.now()
    let lastBody = null
    while (Date.now() - start < 120_000) {
      await new Promise((r) => setTimeout(r, 3000))
      const sr = await fetch(`https://api.kie.ai/api/v1/${slug}/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      })
      const sb = await sr.json().catch(() => ({}))
      lastBody = sb
      const data = sb?.data || sb
      const state = String(data?.state || data?.status || '').toLowerCase()
      if (state === 'success' || state === 'completed' || state === 'done') {
        const urls =
          data?.resultJson?.resultUrls ||
          data?.resultUrls ||
          data?.result?.urls ||
          data?.images?.map?.((i) => i.url || i) ||
          []
        const list = (Array.isArray(urls) ? urls : []).filter(Boolean).map((u) => (typeof u === 'string' ? { url: u } : u))
        if (!list.length) return res.status(502).json({ error: 'KIE returned no image URLs', raw: data })

        // Debit credits (best-effort)
        if (customerId) {
          try {
            await supaFetch('rpc/consume_credits', {
              method: 'POST',
              body: {
                p_customer_id: customerId,
                p_pool_type: 'ai_tokens',
                p_amount: 4000 * list.length,
                p_action: 'consume:image-gen',
                p_profile_id: profile_id,
                p_metadata: { model, aspect, count: list.length, prompt: String(prompt).slice(0, 200) },
              },
            })
          } catch {}
        }
        return res.status(200).json({ images: list, taskId })
      }
      if (state === 'fail' || state === 'failed' || state === 'error') {
        return res.status(502).json({ error: data?.failMsg || data?.message || 'Generation failed', raw: data })
      }
    }
    return res.status(504).json({ error: 'Timed out waiting for KIE', raw: lastBody })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
