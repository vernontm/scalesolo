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
    const { profile_id: rawProfileId, prompt: rawPrompt, platforms } = req.body || {}
    if (!rawProfileId) return res.status(400).json({ error: 'profile_id required' })
    if (!rawPrompt || !String(rawPrompt).trim()) return res.status(400).json({ error: 'prompt required' })
    const selected = (Array.isArray(platforms) ? platforms : [])
      .map((p) => String(p).toLowerCase())
      .filter((p) => VALID_PLATFORMS.has(p))
    if (!selected.length) return res.status(400).json({ error: 'pick at least one platform' })

    // @-mention resolution. Lets worker / cron text-post runs route
    // through a different brand inline ("Quick reaction about
    // @ScaleSolo's pricing change"). The browser already runs this
    // expansion client-side, but server-triggered runs (manual_server
    // dispatch + cron auto_run) don't, so we redo it here so both
    // paths behave the same.
    //
    // - Match @"quoted name" OR @bareToken
    // - Normalize to lowercase letters/digits only
    // - Look up against the caller's accessible brand profiles
    // - First match wins; that brand's id replaces profile_id
    // - The @ token is then swapped with the brand's plain business
    //   name so the model reads natural prose instead of "@".
    let prompt = String(rawPrompt)
    let profile_id = rawProfileId
    const ownedBrands = await supaFetch(
      `profile_access?user_id=eq.${auth.user.id}&select=profile:profiles(id,business_name)`
    ).catch(() => [])
    const brands = (ownedBrands || [])
      .map((row) => row.profile)
      .filter((p) => p && p.business_name)
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
    const byNorm = new Map(brands.map((p) => [norm(p.business_name), p]))
    const tokens = Array.from(new Set(prompt.match(/@(?:"([^"]+)"|([A-Za-z0-9_-]+))/g) || []))
    let firstHit = null
    for (const tok of tokens) {
      const key = norm(tok.replace(/^@"?|"?$/g, ''))
      const hit = byNorm.get(key)
      if (hit) { firstHit = hit; break }
    }
    if (firstHit) profile_id = firstHit.id
    // Strip the @ off matched tokens so the model sees plain names.
    prompt = prompt.replace(/@(?:"([^"]+)"|([A-Za-z0-9_-]+))/g, (full, q, b) => {
      const key = norm(q || b || '')
      return byNorm.has(key) ? byNorm.get(key).business_name : full
    })

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

    const systemPrompt = `You write native social posts in the brand's voice. For each platform you receive, return a tailored variant — same core idea, platform-shaped wording. You ALSO return a canonical title + hashtags + first_comment that ride through to the publishing step.

Platform rules:
${platformRules}

Hard constraints (apply to every variant):
- NEVER use em dashes. Use commas, periods, or colons.
- Stay inside the platform's character limit. CRITICAL for X — keep X under 270 characters as a hard wall. Don't return an empty x value under any circumstance.
- Every platform value must be a non-empty string. If you're tight on space, shorten the core idea, never return "".
- Native voice for each platform. Don't blast the same exact wording across all.
- Use the brand bible / voice rules below as the canonical tone reference.
- Hashtags: 3-5 total, space-separated, each starting with #. Lead with the brand's core hashtags from the bible.
- Title: 6-12 words, click-worthy, no number prefix. Used by LinkedIn / YouTube. Avoid hashtags here.
- first_comment: 80-220 chars, an engagement prompt that lands as the first reply. NEVER duplicates the post, NEVER contains hashtags.
${brandBlocks}

Return ONLY valid JSON, no preamble, no markdown fences:
{
${selected.map((p) => `  "${p}": ""`).join(',\n')},
  "title": "",
  "hashtags": "",
  "first_comment": ""
}`

    const userPrompt = `Write a post about:\n${String(prompt).slice(0, 4000)}`

    let aiData
    try {
      aiData = await message({
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 2500,
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

    // Filter to selected platforms + cap each variant at its hard
    // limit. Track which ones came back empty so we can retry just
    // those with a more aggressive prompt (the all-platforms call
    // occasionally drops the X variant because it's the tightest cap
    // and Claude sometimes prioritizes the longer-form ones).
    const out = {}
    const missing = []
    for (const id of selected) {
      const text = String(parsed[id] || '').trim()
      const cap = PLATFORM_GUIDES[id].max_chars
      out[id] = text.slice(0, cap)
      if (!out[id]) missing.push(id)
    }

    // Per-platform retry. We ask Claude for ONLY the empty platforms
    // with a stripped-down prompt + the previously-generated variants
    // as anchor text so the new variant matches the rest in tone.
    if (missing.length) {
      const anchor = selected.filter((id) => !missing.includes(id) && out[id])
        .map((id) => `${id}: ${out[id]}`).join('\n\n')
      const retrySys = `You're rewriting a short post for specific platforms. Stay tight to the brand voice (already in your system context above). Keep each variant inside its character limit, NO em dashes. Return ONLY valid JSON, no preamble.

${missing.map((id) => `${id}: max ${PLATFORM_GUIDES[id].max_chars} chars. ${PLATFORM_GUIDES[id].voice}`).join('\n')}

Return shape:
{
${missing.map((id) => `  "${id}": ""`).join(',\n')}
}`
      try {
        const retryData = await message({
          system: systemPrompt + '\n\n' + retrySys,
          messages: [{ role: 'user', content: `Original prompt:\n${String(prompt).slice(0, 4000)}\n\nReference variants (match the tone of these):\n${anchor || '(none yet)'}\n\nWrite the missing platforms only.` }],
          max_tokens: 1500,
        })
        const retryRaw = retryData?.content?.[0]?.text || ''
        const rCleaned = retryRaw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
        const rMatch = rCleaned.match(/\{[\s\S]*\}/)
        const rParsed = rMatch ? (() => { try { return JSON.parse(rMatch[0]) } catch { return {} } })() : {}
        for (const id of missing) {
          const t = String(rParsed[id] || '').trim()
          if (t) out[id] = t.slice(0, PLATFORM_GUIDES[id].max_chars)
        }
      } catch (e) {
        console.warn('text-post retry failed:', e?.message)
      }
    }

    return res.status(200).json({
      per_platform: out,
      title:         String(parsed.title || '').trim().slice(0, 200),
      hashtags:      String(parsed.hashtags || '').trim(),
      first_comment: String(parsed.first_comment || '').trim().slice(0, 400),
    })
  } catch (err) {
    console.error('text-post-generate error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}
