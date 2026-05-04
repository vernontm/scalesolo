// POST /api/landing-pages/edit-with-ai
// Body: { profile_id, page_id?, sections, instruction }
// Returns: { sections } — the original sections JSON modified per the
// natural-language instruction (e.g. "change the main color to orange",
// "put a gradient behind the stats section", "shorten the hero subtitle").
//
// We DO NOT mutate the DB here. Caller persists if they accept the diff.
// Debits ai_tokens on success.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { message } from '../_lib/anthropic.js'

const VALID_TYPES = new Set([
  'hero','features','testimonials','pricing','faq','cta','about','stats','logos','video','lead_capture',
])

const SYSTEM = `You are a landing-page editor. The user provides:
1. The current page sections JSON (an array of { id, type, props } objects).
2. A natural-language instruction describing what to change.

Your job: return the ENTIRE updated sections array, preserving every section's
id and any props the user didn't ask to change. Apply the instruction faithfully.

Rules:
- Output ONLY a JSON object: { "sections": [...] }
- Do NOT wrap in code fences. Do NOT add commentary.
- Keep every section's existing "id" exactly as given.
- Keep every type valid: one of hero, features, testimonials, pricing, faq,
  cta, about, stats, logos, video, lead_capture.
- For background changes, prefer setting the "background_image_url" or
  "background_overlay" prop on the relevant section. Use CSS gradients in
  background_overlay (e.g. "linear-gradient(135deg, #ff6b00, #ffaa00)") if
  asked for a gradient.
- For color changes that affect the whole page, mention they should update
  the brand profile's primary color — but ALSO apply visible accents to
  individual sections via background_overlay where it makes sense.
- Never use em dashes anywhere. Use commas, periods, or restructured sentences.
- If the instruction is impossible or unclear, return the sections unchanged.`

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, sections, instruction } = req.body || {}
    if (!profile_id || !instruction || !Array.isArray(sections)) {
      return res.status(400).json({ error: 'profile_id + sections + instruction required' })
    }
    await assertProfileAccess(auth.user.id, profile_id)

    // Pre-flight credit check
    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    if (customerId) {
      const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`)
      if ((Number(pools?.[0]?.balance ?? 0)) < 2000) {
        return res.status(402).json({ error: 'Insufficient AI tokens for this edit. Top up to continue.', code: 'insufficient_credits' })
      }
    }

    const userPrompt = `Current sections:\n${JSON.stringify(sections, null, 2)}\n\nInstruction:\n${instruction.trim()}`

    const resp = await message({
      system: SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 4000,
    })
    const text = resp?.content?.[0]?.text || ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)?.[0]
    if (!jsonMatch) return res.status(502).json({ error: 'AI returned non-JSON', raw: text })
    let parsed
    try { parsed = JSON.parse(jsonMatch) } catch (e) {
      return res.status(502).json({ error: 'AI returned invalid JSON', raw: text })
    }

    // Validate result shape
    const out = Array.isArray(parsed.sections) ? parsed.sections : []
    const cleaned = out
      .filter((s) => s && VALID_TYPES.has(s.type))
      .map((s) => ({
        ...s,
        id: s.id || `s_${Math.random().toString(36).slice(2, 8)}`,
        props: s.props || {},
      }))
    if (cleaned.length === 0) return res.status(502).json({ error: 'AI returned no valid sections', raw: text })

    // Meter credits (best-effort)
    if (customerId && resp.usage) {
      const total = (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0)
      if (total > 0) {
        try {
          await supaFetch('rpc/consume_credits', {
            method: 'POST',
            body: {
              p_customer_id: customerId,
              p_pool_type: 'ai_tokens',
              p_amount: total,
              p_action: 'consume:landing-edit',
              p_profile_id: profile_id,
              p_metadata: { instruction: instruction.slice(0, 200) },
            },
          })
        } catch {}
      }
    }

    return res.status(200).json({ sections: cleaned, usage: resp.usage })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
