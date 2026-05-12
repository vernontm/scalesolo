// POST /api/content/text-post-generate
//
// Body: { profile_id, prompt, platforms: ['x','threads','facebook','linkedin'] }
// Returns: { per_platform: { x, threads, facebook, linkedin } }
//
// Generates a per-platform variant of a text-only social post grounded in
// the brand bible. The text_post_gen node on the canvas calls this — the
// user types or wires in a prompt ("Quick reaction to today's Anthropic
// pricing announcement"), picks which platforms they want, and gets back
// a tailored variant per platform that respects each platform's character
// limit + native shape.
//
// Platforms supported:
//   x         — 280 chars (Twitter). Tight, punchy. No hashtag spam.
//   threads   — 500 chars. Conversational, lowercase-friendly.
//   facebook  — ~500 chars target (Facebook accepts more but engagement
//               drops fast past 500). Plain conversational paragraph.
//   linkedin  — ~1500-2500 chars. Longer-form, line breaks ok, thought-
//               leadership voice.
//
// Each variant is generated INDEPENDENTLY in a single Claude call (one
// system prompt + one user message asking for all variants at once,
// returned as JSON). This keeps cost and latency low while still letting
// each platform have its own voice.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { message } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'

export const config = { maxDuration: 60 }

const VALID_PLATFORMS = new Set(['x', 'threads', 'facebook', 'linkedin'])

// Per-platform shape rules. Used in the system prompt so Claude
// composes within each platform's natural envelope.
const PLATFORM_GUIDES = {
  x: {
    label: 'X (Twitter)',
    max_chars: 280,
    target_chars: '200-275',
    voice: 'Tight, punchy. One idea per post. No emoji walls. 0-2 hashtags max.',
  },
  threads: {
    label: 'Threads',
    max_chars: 500,
    target_chars: '300-450',
    voice: 'Conversational. Lowercase-friendly. Native vibes — feels like a thought, not a marketing post. 0-3 hashtags.',
  },
  facebook: {
    label: 'Facebook',
    max_chars: 2000,
    target_chars: '200-500',
    voice: 'Conversational paragraph. Story-shaped. Hashtags optional, max 5.',
  },
  linkedin: {
    label: 'LinkedIn',
    max_chars: 3000,
    target_chars: '900-1800',
    voice: 'Thought-leadership. Strong hook in line 1, line break, expand. End with a question or takeaway. 3-5 hashtags ok.',
  },
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, prompt, platforms } = req.body || {}
    if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt required' })
    const selected = (Array.isArray(platforms) ? platforms : [])
      .map((p) => String(p).toLowerCase())
      .filter((p) => VALID_PLATFORMS.has(p))
    if (!selected.length) return res.status(400).json({ error: 'pick at least one platform' })
    await assertProfileAccess(auth.user.id, profile_id)

    const ctx = await loadBrandContext(profile_id, { skip: ['exemplars'] })
    if (!ctx.profile) return res.status(404).json({ error: 'Profile not found' })
    const brandBlocks = renderBrandContextMarkdown(ctx, {
      include: ['identity', 'bible', 'summary', 'rules'],
      bibleCharLimit: 2500,
    })

    const platformRules = selected
      .map((id) => {
        const g = PLATFORM_GUIDES[id]
        return `- ${id} (${g.label}): max ${g.max_chars} chars, target ${g.target_chars}. ${g.voice}`
      })
      .join('\n')

    const systemPrompt = `You write native social posts in the brand's voice. For each platform you receive, return a tailored variant — same core idea, platform-shaped wording.

Platform rules:
${platformRules}

Hard constraints (apply to every variant):
- NEVER use em dashes (—). Use commas, periods, or colons.
- Stay inside the platform's character limit.
- Native voice for each platform. Don't blast the same exact wording across all.
- Use the brand bible / voice rules below as the canonical tone reference.
${brandBlocks}

Return ONLY valid JSON, no preamble, no markdown fences:
{
${selected.map((p) => `  "${p}": ""`).join(',\n')}
}`

    const userPrompt = `Write a post about:\n${String(prompt).slice(0, 4000)}`

    let aiData
    try {
      aiData = await message({
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 2000,
      })
    } catch (e) {
      return res.status(e?.status === 401 ? 401 : 502).json({
        error: `Text-post generation failed: ${e?.message || e}`,
      })
    }

    const raw = aiData?.content?.[0]?.text || ''
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    const m = cleaned.match(/\{[\s\S]*\}/)
    let parsed = {}
    try { parsed = JSON.parse(m ? m[0] : cleaned) } catch { parsed = {} }

    // Filter to selected platforms + cap each variant at its hard limit.
    const out = {}
    for (const id of selected) {
      const text = String(parsed[id] || '').trim()
      const cap = PLATFORM_GUIDES[id].max_chars
      out[id] = text.slice(0, cap)
    }
    return res.status(200).json({ per_platform: out })
  } catch (err) {
    console.error('text-post-generate error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
