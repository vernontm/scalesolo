// POST /api/content/caption-fanout
// Body: { profile_id, segments: [{ idx, text }, ...] }
// Returns: { sets: [{ idx, title, caption, hashtags, first_comment }, ...] }
//
// Dedicated endpoint for caption_gen's multi-clip fan-out. Calls Claude
// directly with a prompt scoped JUST to "produce N caption sets as JSON"
// and a clean caption-writer system prompt — none of the script-writer
// hook-archetype-rotation context that /api/content/generate loads (which
// was confusing Claude into writing a script instead of returning the
// sets[] array, leaving worker caption_gen with "no sets across any
// batch" failures).
//
// Brand context still applies — we load + render it from the profile
// so the captions stay on-brand. We just keep the system prompt focused.

import { setCors, requireUser, assertProfileAccess } from '../_lib/supabase.js'
import { message } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'

export const config = { maxDuration: 120 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST')     return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { profile_id, segments } = req.body || {}
    if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
    if (!Array.isArray(segments) || !segments.length) {
      return res.status(400).json({ error: 'segments array required' })
    }
    await assertProfileAccess(auth.user.id, profile_id)

    // Brand context for on-brand voice. Failures are non-fatal — we
    // still produce captions, just less brand-aware.
    const brandCtx = await loadBrandContext(profile_id).catch(() => null)
    const brandMd  = brandCtx ? renderBrandContextMarkdown(brandCtx) : ''

    const systemPrompt = `You write social-post captions for a brand.
You output ONLY valid JSON. Do not write scripts, hooks, intros, or
explanations — your entire response is one JSON object with a "sets"
array. Each set is one independent social post's caption package.

Brand voice rules apply to EVERY caption:
- NEVER use em dashes. Use commas, periods, or colons.
- Plain text in captions. No markdown.
- Hashtags ALWAYS start with #.

<brand_context>
${brandMd || '(no brand context provided)'}
</brand_context>`

    const userPrompt = `Write ${segments.length} INDEPENDENT caption sets — one per segment below. Each segment becomes its own social post, so each set must stand on its own.

Per-set rules (apply to EVERY set):
- title: ≤ 80 chars, click-worthy, no number prefix.
- caption: ≤ 1500 chars. Strong hook in the first sentence. Reads naturally on every platform (TikTok / IG / YouTube / Facebook / X / LinkedIn / Threads).
- hashtags: EXACTLY 5, space-separated, each starting with #. Lead with the brand's core hashtags from the brand bible.
- first_comment: ≤ 220 chars. Engagement driver, not a duplicate of the caption, no hashtags.

Across-the-batch rules:
- Each set must be DIFFERENT — different hook, different angle, different vocabulary.
- Match each segment's actual content. The hook of set #3 should reflect segment #3, not segment #1.
- Voice stays consistent (same brand) but the substance varies.

Use each segment's EXACT "idx" value as the set's idx (do NOT renumber).

Return ONLY this JSON shape, no preamble, no markdown fences:
{
  "sets": [
    { "idx": ${segments[0].idx}, "title": "", "caption": "", "hashtags": "#a #b #c #d #e", "first_comment": "" }
  ]
}

Segments:
${segments.map((s) => `--- segment ${s.idx} ---\n${String(s.text || '').slice(0, 800)}`).join('\n\n')}`

    const resp = await message({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      // 4000 fits ~16 caption sets cleanly (each ~250 tokens of JSON).
      // Caller batches at 10/group so this is comfortable headroom.
      max_tokens: 4000,
    })

    const raw = (resp?.content?.find?.((b) => b.type === 'text')?.text || '').trim()
    let parsed = {}
    try {
      const cleaned = raw.replace(/```json\s*|```\s*/gi, '').trim()
      const m = cleaned.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(m ? m[0] : cleaned)
    } catch (e) {
      // Tolerant fallback: pull individual set-shaped objects out of
      // partial JSON via regex when the response was truncated.
      const objs = (raw.match(/\{[^{}]*"idx"\s*:\s*-?\d+[^{}]*\}/g) || [])
      const out = []
      for (const o of objs) {
        try { out.push(JSON.parse(o)) } catch {}
      }
      parsed = { sets: out }
    }

    const sets = Array.isArray(parsed?.sets) ? parsed.sets : []
    if (!sets.length) {
      // Log enough of the raw response to diagnose. Don't echo it back
      // to the client by default — could be huge.
      console.warn('[caption-fanout] no sets parsed. raw preview:', String(raw).slice(0, 600))
      return res.status(502).json({
        error: 'Claude returned no parseable caption sets',
        debug_preview: process.env.NODE_ENV === 'production' ? undefined : String(raw).slice(0, 600),
      })
    }
    return res.status(200).json({ sets })
  } catch (err) {
    console.error('caption-fanout error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
