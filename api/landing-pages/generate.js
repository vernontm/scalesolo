// POST /api/landing-pages/generate
// Body: { profile_id, description } → returns { sections, meta }
//   Claude reads the brand bible + voice + audience and emits a sections array
//   ready to drop into landing_pages.sections.
import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { message } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'

const SECTION_TYPES = ['hero','features','testimonials','pricing','faq','cta','about','stats','logos','video','gallery','form']

const SYSTEM = `You are a landing-page architect. Given a brief, return a JSON object:
{
  "meta":     { "title": "...", "description": "...", "og_image": null },
  "sections": [
    {
      "type": "hero" | "features" | "testimonials" | "pricing" | "faq" | "cta" | "about" | "stats" | "logos" | "video",
      "id": "<short-id>",
      "props": { ...type-specific props... }
    }
  ]
}

Section schemas (use these exactly):
- hero        { eyebrow?, title, subtitle, cta_label, cta_url, image_url? }
- features    { title, items: [{ title, body, icon? }] }   // 3-6 items
- testimonials { title, quotes: [{ quote, author, role? }] }   // 2-4 quotes
- pricing     { title, tiers: [{ name, price_label, features: [string], cta_label, cta_url, popular? }] }
- faq         { title, items: [{ q, a }] }   // 4-8 items
- cta         { title, subtitle, cta_label, cta_url }
- about       { title, body }
- stats       { items: [{ value, label }] }   // 3-4 items
- logos       { title, items: [{ name, image_url? }] }
- video       { title?, video_url }

Rules:
- Use the brand voice and bible verbatim. Direct, candid, no fluff.
- Never use em dashes anywhere. Use commas, periods, or restructured sentences.
- Pick 4-7 sections that fit the brief. Always include a hero and a final cta.
- Output ONLY the JSON object — no commentary, no fences.`

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, description } = req.body || {}
    if (!profile_id || !description) return res.status(400).json({ error: 'profile_id + description required' })
    await assertProfileAccess(auth.user.id, profile_id)

    // Brand context — same source as the script generator. Includes
    // bible + voice summary + hard rules so generated landing copy
    // respects do_not_say / always_include just like a generated
    // script would. Skip exemplars and hooks — they're shaped for
    // social copy, not landing pages.
    const ctx = await loadBrandContext(profile_id, { skip: ['exemplars', 'hooks', 'disliked'] })
    const profile = ctx.profile || {}
    const brandBlocks = renderBrandContextMarkdown(ctx, {
      include: ['bible', 'summary', 'rules'],
      bibleCharLimit: 2500,
    })

    const identityHeader =
      `## Brand\n${profile.business_name || ''}` +
      (profile.preferred_tone ? `\nVoice: ${profile.preferred_tone}` : '') +
      (profile.target_audience ? `\nAudience: ${profile.target_audience}` : '')

    const systemPrompt = `${SYSTEM}

${identityHeader}${brandBlocks}`

    const resp = await message({
      system: systemPrompt,
      messages: [{ role: 'user', content: description }],
      max_tokens: 3000,
    })
    const text = resp?.content?.[0]?.text || ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)?.[0]
    if (!jsonMatch) return res.status(502).json({ error: 'AI returned non-JSON', raw: text })
    let parsed
    try { parsed = JSON.parse(jsonMatch) } catch (e) {
      return res.status(502).json({ error: 'AI returned invalid JSON', raw: text })
    }

    // Filter to known section types + ensure each has an id
    parsed.sections = (parsed.sections || []).filter((s) => SECTION_TYPES.includes(s.type)).map((s) => ({
      ...s,
      id: s.id || `s_${Math.random().toString(36).slice(2, 8)}`,
    }))

    // Meter credits (best-effort)
    try {
      const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
      const customerId = cust?.[0]?.id
      if (customerId && resp.usage) {
        const total = (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0)
        if (total > 0) {
          await supaFetch('rpc/consume_credits', {
            method: 'POST',
            body: {
              p_customer_id: customerId,
              p_pool_type: 'ai_tokens',
              p_amount: total,
              p_action: 'consume:landing-generate',
              p_profile_id: profile_id,
              p_metadata: { description: description.slice(0, 200) },
            },
          })
        }
      }
    } catch {}

    return res.status(200).json({ ...parsed, usage: resp.usage })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
