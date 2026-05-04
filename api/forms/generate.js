// Generate a form from a natural-language description using Claude.
// POST { profile_id, description } → { sections, confirmation }
import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { message } from '../_lib/anthropic.js'

const SYSTEM = `You are a form builder. Given a description, return a JSON object with shape:
{
  "sections": [
    {
      "id": "<short-id>",
      "title": "<optional section title>",
      "fields": [
        { "id": "<field-id>", "type": "text|email|phone|textarea|dropdown|multi-choice|checkbox", "label": "<label>", "required": true|false, "placeholder": "<optional>", "options": ["..."] (for dropdown/multi-choice/checkbox) }
      ]
    }
  ],
  "confirmation": { "kind": "message", "message": "<Thanks message>" }
}
Rules:
- Always include an email field (type=email, required=true).
- Keep questions short and conversational. Aim for 4-7 fields total unless asked otherwise.
- Use sensible field IDs (snake_case, no spaces).
- Never use em dashes.
- Return ONLY the JSON object — no commentary, no code fences.`

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

    const resp = await message({
      system: SYSTEM,
      messages: [{ role: 'user', content: description }],
      max_tokens: 2000,
    })
    const text = resp?.content?.[0]?.text || ''
    const json = text.match(/\{[\s\S]*\}/)?.[0]
    if (!json) return res.status(502).json({ error: 'AI returned non-JSON', raw: text })
    let parsed
    try { parsed = JSON.parse(json) } catch (e) {
      return res.status(502).json({ error: 'AI returned invalid JSON', raw: text })
    }

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
              p_action: 'consume:form-generate',
              p_profile_id: profile_id,
              p_metadata: { description: description.slice(0, 200) },
            },
          })
        }
      }
    } catch {}

    return res.status(200).json(parsed)
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
