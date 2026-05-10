// POST /api/reference-videos/analyze
// Body: { id }
//
// Reads a transcribed reference_videos row and asks Claude to extract
// discrete brand-voice insights (hook patterns, structural beats,
// vocabulary, pacing, cta patterns, audience signals, adaptable
// elements, conflicts with the user's bible). Each insight goes into
// brand_bible_insights with status='pending' so the user can approve
// or reject before anything merges into the brand voice.
//
// Output: { insights: [...] }

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { message } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'

const ANALYSIS_SYSTEM = `You are a brand voice analyst. Given a competitor or aspirational TikTok transcript and the user's existing brand bible, extract discrete patterns the user can adopt without losing their voice.

Return ONLY a JSON object of this shape:
{
  "insights": [
    {
      "insight_type": "hook_pattern" | "structural_beat" | "vocabulary" | "pacing" | "cta_pattern" | "audience_signal" | "adaptable_element" | "conflict",
      "title": "<3-8 words summarizing the pattern>",
      "description": "<1-3 sentences describing what it is, why it works, how to use it>",
      "example": "<exact quote from the transcript that demonstrates it>",
      "fit": "high" | "medium" | "low"   // how well it fits the user's existing voice
    }
  ]
}

Rules:
- Be concrete and observational, not generic. Quote specific phrases.
- Surface 5-10 insights total. Quality over quantity.
- 'conflict' captures patterns that DIRECTLY clash with the user's bible (use sparingly).
- 'adaptable_element' is the highest-value type: a pattern they could realistically use as-is or with minor changes.
- DO NOT recommend they copy. Recommend what they can learn.
- Never use em dashes anywhere in the output.`

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { id } = req.body || {}
    if (!id) return res.status(400).json({ error: 'id required' })

    const rows = await supaFetch(
      `reference_videos?id=eq.${encodeURIComponent(id)}&select=id,profile_id,transcript,creator_handle,source_url`
    )
    const ref = rows?.[0]
    if (!ref) return res.status(404).json({ error: 'Reference video not found' })
    await assertProfileAccess(auth.user.id, ref.profile_id)
    if (!ref.transcript || ref.transcript.length < 30) {
      return res.status(400).json({ error: 'Reference video has no transcript yet. Wait for transcription to complete.' })
    }

    // Brand context — Claude needs the user's bible + voice summary so
    // it can flag conflicts vs adaptable elements.
    const ctx = await loadBrandContext(ref.profile_id, { skip: ['exemplars', 'disliked'] })
    const brandBlocks = renderBrandContextMarkdown(ctx, {
      include: ['identity', 'bible', 'summary', 'rules'],
      bibleCharLimit: 2000,
    })

    const userPrompt = `Transcript${ref.creator_handle ? ` (from @${ref.creator_handle})` : ''}:
"""
${ref.transcript.slice(0, 8000)}
"""

Source URL: ${ref.source_url}

User brand context:
${brandBlocks}

Extract patterns and return the JSON described in your system prompt.`

    let resp
    try {
      resp = await message({
        system: ANALYSIS_SYSTEM,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 3000,
      })
    } catch (e) {
      return res.status(502).json({ error: `Claude analyze failed: ${e.message}` })
    }
    const raw = resp?.content?.[0]?.text || ''
    const m = raw.match(/\{[\s\S]*\}/)?.[0]
    if (!m) return res.status(502).json({ error: 'AI returned non-JSON', raw: raw.slice(0, 400) })
    let parsed
    try { parsed = JSON.parse(m) } catch (e) {
      return res.status(502).json({ error: `AI returned invalid JSON: ${e.message}`, raw: raw.slice(0, 400) })
    }
    const insights = Array.isArray(parsed.insights) ? parsed.insights : []
    if (!insights.length) return res.status(200).json({ insights: [] })

    // Persist each insight as pending. Old insights for this video
    // get overwritten so a re-analyze doesn't pile up duplicates.
    await supaFetch(
      `brand_bible_insights?source_video_id=eq.${encodeURIComponent(id)}&status=eq.pending`,
      { method: 'DELETE', prefer: 'return=minimal' }
    ).catch(() => {})

    const rowsToInsert = insights.slice(0, 12).map((i) => ({
      profile_id: ref.profile_id,
      source_video_id: ref.id,
      insight_type: typeof i.insight_type === 'string' ? i.insight_type : 'adaptable_element',
      title: typeof i.title === 'string' ? i.title.slice(0, 240) : null,
      payload: {
        description: typeof i.description === 'string' ? i.description.slice(0, 1200) : '',
        example:     typeof i.example === 'string' ? i.example.slice(0, 600) : '',
        fit:         typeof i.fit === 'string' ? i.fit : 'medium',
      },
      status: 'pending',
    }))
    const inserted = await supaFetch('brand_bible_insights', { method: 'POST', body: rowsToInsert })
    return res.status(200).json({ insights: Array.isArray(inserted) ? inserted : [] })
  } catch (err) {
    console.error('reference-videos/analyze error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
