// POST /api/scripts/split
// Body: { script, count }
// Returns: { chunks: [...] }
//
// Used by the avatar_render randomize path: takes a long script and splits
// it into `count` roughly-equal speaking chunks (preserving sentence
// boundaries) so each chunk can be rendered against a different image
// from the avatar's look folder, then stitched back together.

import { setCors, requireUser, supaFetch } from '../_lib/supabase.js'
import { message } from '../_lib/anthropic.js'

const SYSTEM = `You split video scripts into N roughly equal speaking-time chunks. Each chunk:
- Is a coherent unit (one sentence, or two short related sentences).
- Preserves the original wording — DO NOT rewrite or summarize.
- Together, the chunks must concatenate verbatim into the original script (whitespace tolerant).
- Return ONLY valid JSON: { "chunks": ["...","..."] }
- The chunks array length MUST equal N exactly.
- Never use em dashes anywhere; use commas, periods, or restructured sentences if you need to choose.`

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { script, count } = req.body || {}
    if (!script || !count) return res.status(400).json({ error: 'script + count required' })
    const n = Math.max(1, Math.min(20, Number(count) || 1))

    // Pre-flight credit check (small)
    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    if (customerId) {
      const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`)
      if ((Number(pools?.[0]?.balance ?? 0)) < 800) {
        return res.status(402).json({ error: 'Insufficient AI tokens.', code: 'insufficient_credits' })
      }
    }

    if (n === 1) return res.status(200).json({ chunks: [String(script).trim()] })

    const resp = await message({
      system: SYSTEM,
      messages: [{ role: 'user', content: `N=${n}\n\nScript:\n${String(script).slice(0, 6000)}` }],
      max_tokens: 1500,
    })
    const text = resp?.content?.[0]?.text || ''
    const json = text.match(/\{[\s\S]*\}/)?.[0]
    let parsed = null
    if (json) { try { parsed = JSON.parse(json) } catch {} }
    let chunks = Array.isArray(parsed?.chunks) ? parsed.chunks : null

    // Fallback: naive sentence split + greedy bucket if Claude misbehaved.
    if (!chunks || chunks.length !== n) {
      const sentences = String(script).split(/(?<=[.!?])\s+/).filter(Boolean)
      chunks = []
      const per = Math.ceil(sentences.length / n)
      for (let i = 0; i < n; i++) {
        const start = i * per
        const slice = sentences.slice(start, start + per).join(' ').trim()
        chunks.push(slice || String(script))
      }
    }

    if (customerId && resp?.usage) {
      const total = (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0)
      if (total > 0) {
        try {
          await supaFetch('rpc/consume_credits', {
            method: 'POST',
            body: {
              p_customer_id: customerId,
              p_pool_type: 'ai_tokens',
              p_amount: total,
              p_action: 'consume:script-split',
              p_metadata: { count: n, script_len: String(script).length },
            },
          })
        } catch {}
      }
    }

    return res.status(200).json({ chunks: chunks.map((c) => String(c).trim()) })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
