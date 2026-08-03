// POST /api/walkthroughs/ideas  { profile_id }
// Returns: { ideas: [string, string, string] }
//
// Three short "walkthrough video" topic ideas in the brand's voice, to
// autofill the builder. Cheap text-only call; not credit-gated.

import { setCors, requireUser, assertProfileAccess } from '../_lib/supabase.js'
import { message as anthropicMessage } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    const { profile_id } = req.body || {}
    if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
    await assertProfileAccess(auth.user.id, profile_id)

    let brandMd = ''
    try { brandMd = renderBrandContextMarkdown(await loadBrandContext(profile_id), { exclude: ['exemplars'] }) } catch { /* brandless */ }

    const out = await anthropicMessage({
      model: 'claude-sonnet-5',
      max_tokens: 500,
      system: [
        'Suggest 3 short, specific topic ideas for a 30 to 60 second talking-head WALKTHROUGH video for this brand.',
        'The best ones teach or explain one thing the audience wants (a how-to, a mistake to avoid, a quick framework).',
        'Each idea is one line, <= 12 words, concrete, in the brand voice.',
        'Return ONLY a JSON array of 3 strings. No preamble. NO em dashes.',
        brandMd ? `\nBrand context:\n${brandMd}` : '',
      ].filter(Boolean).join('\n'),
      messages: [{ role: 'user', content: 'Give me 3 walkthrough video ideas.' }],
    })
    let text = (out?.content || []).map((c) => c?.text || '').join('').trim()
    text = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)
    let ideas = []
    try { ideas = JSON.parse(text) } catch { ideas = [] }
    ideas = (Array.isArray(ideas) ? ideas : []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 3)
    return res.status(200).json({ ideas })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
