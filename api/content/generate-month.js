// POST /api/content/generate-month
//
// Plan + (optionally) generate a month's worth of social posts in one
// shot. Two phases so the UI can show a cost + count preview before
// burning credits:
//
//   ?phase=preview  → cost / count estimate, no Claude calls, no rows
//   ?phase=run      → actually calls Claude in day-chunks, inserts
//                     content_scripts rows with approval_status='pending'.
//                     Returns { inserted, next_offset, done }.
//                     Caller loops back with the returned offset until
//                     done=true; lets a 480-post job fit inside the
//                     Vercel 300s function budget.
//
// Body (both phases):
//   {
//     profile_id, goal, platforms: ['threads','instagram','twitter','facebook',...],
//     posts_per_day_per_platform: 4,
//     start_date_iso?,        // default = today, local profile tz
//     end_date_iso?,          // default = last day of start_date's month
//     timezone?,              // IANA, default 'America/Chicago'
//     // run-phase only
//     day_offset?,            // 0-based day index to resume from (default 0)
//     chunk_days?,            // days to process this call (default 3)
//   }
//
// Pricing assumptions (kept conservative; revisit if Anthropic prices
// move). Used by the preview phase only; we never charge here.
//   - ~1500 input tokens / day-chunk-call (brand context cached after
//     first call so this is the marginal cost)
//   - ~600 output tokens per post (very generous; caption + hashtags)

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { capHashtags } from '../_lib/hashtags.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'
import { message as anthropicMessage } from '../_lib/anthropic.js'

export const config = { maxDuration: 300 }

// Platforms our system understands. Names match upload-post + the
// social_platform_tags map. Any string outside this set is dropped.
// Note: "twitter" coming from older callers is normalized to "x" below.
const VALID_PLATFORMS = new Set([
  'threads', 'instagram', 'x', 'facebook',
  'tiktok', 'youtube', 'linkedin', 'pinterest', 'bluesky', 'reddit',
])
// Legacy → canonical platform aliases. Strips any old "twitter" string
// callers might still send so the row stores "x" everywhere
// (per_platform_text key, platforms[] entry, Upload-Post submission).
const PLATFORM_ALIASES = { twitter: 'x' }
function normalizePlatform(p) {
  const s = String(p || '').toLowerCase()
  return PLATFORM_ALIASES[s] || s
}

// Per-platform copy guardrails: char ceiling + format hints baked into
// the Claude system prompt so a single response carries per-platform
// variants without manual trimming.
const PLATFORM_RULES = {
  threads:   { max: 500,   tone: 'Punchy, short declarative lines. 3-5 lines max. No em dashes. Confident, not hype.' },
  x:         { max: 280,   tone: 'One tight idea per post. Lead with the punchline. No threads (the platform handles cross-posting).' },
  instagram: { max: 2200,  tone: 'Hook in line 1, breath in line 2, 2-3 supporting beats, then a soft question or invite.' },
  facebook:  { max: 1000,  tone: 'Conversational, slightly longer. Story or insight format. Comfortable with paragraphs.' },
  tiktok:    { max: 2200,  tone: 'High-energy caption that pairs with the video. Hook + payoff.' },
  youtube:   { max: 5000,  tone: 'Description-style. SEO-aware first 150 chars, then expand.' },
  linkedin:  { max: 3000,  tone: 'Professional with personality. Bullets ok. End with a question or POV.' },
  pinterest: { max: 800,   tone: 'SEO-keyword forward. Describe the value of the pin clearly.' },
  bluesky:   { max: 300,   tone: 'Short, casual, network-aware. Skip hashtags.' },
  reddit:    { max: 300,   tone: 'Title is everything; body lives elsewhere. Question or hot-take form.' },
}

// Cost lookups for the preview phase. Anthropic posts cents/Mtok prices —
// these are 2026 Sonnet 4.5 list prices ($3/$15 per million in/out).
const SONNET_IN_PER_MTOK  = 3.00
const SONNET_OUT_PER_MTOK = 15.00

function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x }
function endOfMonth(d) { const x = new Date(d); x.setMonth(x.getMonth()+1, 0); x.setHours(23,59,59,999); return x }
function dateIso(d) { return d.toISOString() }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate()+n); return x }
function daysBetween(a, b) {
  const ms = startOfDay(b) - startOfDay(a)
  return Math.max(0, Math.round(ms / 86400000) + 1)
}

// Spread N posts evenly across a single day's daylight hours. Returns
// ISO timestamps in the profile's local timezone. We pick a window of
// 8am → 9pm so posts feel naturally distributed rather than all hitting
// at midnight.
function distributeDay(date, count, tz) {
  // tz isn't used to construct the time — we build a local-feeling time
  // by setting hours on the Date and relying on the user's downstream
  // scheduling to interpret it. Good enough for v1.
  const out = []
  if (count <= 0) return out
  const dayStart = new Date(date); dayStart.setHours(8, 0, 0, 0)
  const dayEnd   = new Date(date); dayEnd.setHours(21, 0, 0, 0)
  const span = dayEnd - dayStart
  for (let i = 0; i < count; i++) {
    const offset = count === 1 ? span / 2 : (span / (count - 1)) * i
    out.push(new Date(dayStart.getTime() + offset).toISOString())
  }
  return out
}

function buildSystemPrompt(ctx, opts) {
  const brand = renderBrandContextMarkdown(ctx, {
    // Visual refs help when the user later runs image-gen; safe to
    // include — Claude won't fetch the URLs, it just sees them as
    // "patterns we like". Cheap context relative to the bibles.
    include: ['identity','bible','summary','exemplars','hooks','bad_patterns','rules','visual_refs'],
    bibleCharLimit: 1800,
    visualRefKinds: ['threads','carousel','graphic'],
  })

  const platformList = opts.platforms
    .map((p) => `- ${p} (max ${PLATFORM_RULES[p]?.max ?? 1000} chars): ${PLATFORM_RULES[p]?.tone ?? 'Default brand voice.'}`)
    .join('\n')

  // CTAs come off the profile (profiles.brand_ctas). When present we
  // tell Claude to pick the best-fit URL per post and weave it into
  // the closing of every caption + per-platform variant. Without this
  // generations come out URL-less and the user has to retrofit them.
  const ctas = Array.isArray(ctx?.profile?.brand_ctas) ? ctx.profile.brand_ctas : []
  const ctaBlock = ctas.length
    ? `\n## CTAs — pick the best-fit URL for each post\n${ctas.map((c, i) =>
        `${i + 1}. "${c.label}" → ${c.url}\n   Best fit: ${c.when || 'general'}`
      ).join('\n')}\n\n**EVERY post MUST end with one of these CTAs**, appended after a blank line, in the form:\n  {label}: {url}\n\nApply to caption AND every per_platform_text variant. Trim platform variants to fit their char limits BEFORE adding the CTA — never let the CTA push the post past the cap.`
    : ''

  return `You are this brand's social content strategist. You write posts that read like the brand wrote them — never generic AI copy.

${brand}

## Monthly content goal
${String(opts.goal || '').trim() || 'Drive engagement and consistent presence; reinforce the brand thesis.'}

## Platforms you'll write for this run
${platformList}${ctaBlock}

## Output rules — read carefully
- Respond with ONLY a JSON array. No markdown, no commentary, no preface.
- Each element is one post object with shape:
  {
    "date": "YYYY-MM-DD",
    "title": "<3-9 word headline in Title Case — surfaces on Facebook as the post name, must read like a real headline, not a slug>",
    "hook": "<the opening line — must read like the brand on its best day>",
    "caption": "<the base text, no platform suffix — 250-450 characters TOTAL (hard cap 450). One hook line, 1-2 short beats, a one-line closer. No stacked story paragraphs.>",
    "hashtags": "<space-separated, at most 5>",
    "per_platform_text": { "threads": "...", "instagram": "...", "x": "...", "facebook": "..." }
  }
- per_platform_text MUST include an entry for EVERY platform in the platform list above. If the same body works for multiple platforms, write it slightly differently for each — never identical strings. Trim to each platform's char limit.
- Vary post structures across the day: a list-style post, a story-style post, a question, a hot take. Do not repeat the same opening pattern within a 3-day window.
- Never use em dashes. Use commas, periods, or colons instead.
- No emojis unless the brand exemplars use them.
- Each post stands on its own; do not reference "yesterday's post" or "as I said earlier".
- Return ONLY the JSON array — start with [ and end with ].`
}

function buildUserPrompt(dayWindow, postsPerDay, platforms) {
  const days = dayWindow.map((d) => d.toISOString().slice(0, 10))
  return `Generate ${postsPerDay} posts for EACH of these dates: ${days.join(', ')}.

That's ${postsPerDay * days.length} posts total. Each post must have per_platform_text covering all of: ${platforms.join(', ')}.

Vary the angles — same brand, different lenses (educational, contrarian, personal, behind-the-scenes, win-share, callout).`
}

function safeParseJsonArray(raw) {
  if (!raw) return []
  // Strip code fences if the model leaked any.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // Pull the first [...] block if the model prepended prose.
    const m = cleaned.match(/\[[\s\S]*\]/)
    if (m) {
      try { return JSON.parse(m[0]) } catch { /* fall through to recovery */ }
    }
    // Recovery for truncated arrays — Claude hit max_tokens mid-element.
    // Slice up to the last complete `}` and close the array. We accept
    // a partial response (e.g. 6 of 8 posts) rather than failing the
    // whole chunk; downstream code just gets fewer rows for the day.
    const arrStart = cleaned.indexOf('[')
    if (arrStart >= 0) {
      const lastClose = cleaned.lastIndexOf('}')
      if (lastClose > arrStart) {
        const trimmed = cleaned.slice(arrStart, lastClose + 1) + ']'
        try {
          const parsed = JSON.parse(trimmed)
          return Array.isArray(parsed) ? parsed : []
        } catch { /* give up */ }
      }
    }
    return []
  }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const body = req.body || {}
    const profileId = body.profile_id
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })
    await assertProfileAccess(auth.user.id, profileId)

    const platforms = (Array.isArray(body.platforms) ? body.platforms : [])
      .map(normalizePlatform)
      .filter((p) => VALID_PLATFORMS.has(p))
    if (!platforms.length) return res.status(400).json({ error: 'at least one valid platform required' })

    const postsPerDay = Math.max(1, Math.min(20, Number(body.posts_per_day_per_platform || 1)))
    const tz = String(body.timezone || 'America/Chicago')

    const startDate = startOfDay(body.start_date_iso ? new Date(body.start_date_iso) : new Date())
    const endDate   = endOfMonth(body.end_date_iso ? new Date(body.end_date_iso) : startDate)
    const totalDays = daysBetween(startDate, endDate)
    if (totalDays <= 0) return res.status(400).json({ error: 'date range is empty' })

    const totalPosts = totalDays * postsPerDay
    const phase = String(req.query.phase || 'preview')

    // ── PREVIEW ───────────────────────────────────────────────────
    if (phase === 'preview') {
      // Token math — each day-chunk is one Claude call. We chunk by 3 days
      // by default. Brand context after first call hits the prompt cache
      // (90% discount), so we account ~1500 prompt-input for the first
      // call and ~150 for the rest.
      const chunkDays = Math.max(1, Math.min(7, Number(body.chunk_days || 1)))
      const chunks = Math.ceil(totalDays / chunkDays)
      const inTokensFirst = 4500
      const inTokensCachedPerChunk = 600
      const inTotal = inTokensFirst + (chunks - 1) * inTokensCachedPerChunk
      // Per-post output budget: ~500 output tokens × posts_per_chunk
      const postsPerChunk = chunkDays * postsPerDay
      const outTotal = chunks * postsPerChunk * platforms.length * 250
      const costUsd =
        (inTotal  / 1_000_000) * SONNET_IN_PER_MTOK +
        (outTotal / 1_000_000) * SONNET_OUT_PER_MTOK

      return res.status(200).json({
        phase: 'preview',
        start_date_iso: dateIso(startDate),
        end_date_iso:   dateIso(endDate),
        total_days:     totalDays,
        posts_per_day_per_platform: postsPerDay,
        platforms,
        total_posts:    totalPosts,
        chunk_days:     chunkDays,
        chunks,
        estimated_cost_usd: Number(costUsd.toFixed(2)),
        estimated_seconds:  Math.ceil(chunks * 18), // ~18s per chunk in practice
      })
    }

    // ── RUN ───────────────────────────────────────────────────────
    if (phase !== 'run') return res.status(400).json({ error: 'phase must be preview or run' })

    // Persist goal back to the profile on the first chunk so the modal
    // pre-fills it next month. Skip when offset > 0 (subsequent chunks
    // shouldn't overwrite an in-flight value).
    const offset    = Math.max(0, Number(body.day_offset || 0))
    const chunkDays = Math.max(1, Math.min(7, Number(body.chunk_days || 1)))
    if (offset === 0) {
      try {
        await supaFetch(`profiles?id=eq.${profileId}`, {
          method: 'PATCH',
          body: { monthly_content_goal: String(body.goal || '').slice(0, 4000) || null },
        })
      } catch { /* best-effort */ }
    }

    // Build the day window for this chunk.
    const dayWindow = []
    for (let i = 0; i < chunkDays && (offset + i) < totalDays; i++) {
      dayWindow.push(addDays(startDate, offset + i))
    }
    if (!dayWindow.length) {
      return res.status(200).json({ phase: 'run', inserted: [], failed: [], next_offset: totalDays, done: true })
    }

    // Load brand context once (cached server-side via Claude prompt cache
    // on subsequent calls, but the supaFetch reads happen each call —
    // negligible cost).
    const ctx = await loadBrandContext(profileId)
    const system = buildSystemPrompt(ctx, { platforms, goal: body.goal })
    const user   = buildUserPrompt(dayWindow, postsPerDay, platforms)

    // Two-attempt loop. The first call uses the standard user prompt;
    // if Claude returns prose / partial JSON / no posts, retry once
    // with a strict "JSON ONLY, no prose" prefix. Retrying covers the
    // ~5% of calls where Claude leaks a "Here's the array:" preface or
    // appends commentary after the closing bracket, both of which our
    // recovery parser can usually handle but sometimes can't.
    const attempts = [
      user,
      `${user}\n\n# FINAL REMINDER\nReturn ONLY a valid JSON array. No prose, no markdown, no preface. Start with [ and end with ]. The previous attempt was not parseable.`,
    ]
    let posts = []
    let stopReason = null
    let rawLast = ''
    let claudeErr = null
    for (let attempt = 0; attempt < attempts.length; attempt++) {
      try {
        const claudeResp = await anthropicMessage({
          system,
          messages: [{ role: 'user', content: attempts[attempt] }],
          // 16384 (Sonnet 4.5 supports up to 64k). Single-day chunks
          // with ~16 posts × ~600 tokens of per_platform_text fit
          // comfortably here without truncation.
          max_tokens: 16384,
        })
        rawLast = claudeResp?.content?.find?.((c) => c.type === 'text')?.text || ''
        stopReason = claudeResp?.stop_reason
        posts = safeParseJsonArray(rawLast)
        if (posts.length) break
      } catch (e) {
        claudeErr = e
        // Network / 5xx — fall through to retry. If both attempts hit
        // network errors we surface the second one below.
      }
    }
    if (!posts.length) {
      return res.status(502).json({
        error: claudeErr
          ? `Claude call failed: ${claudeErr?.message || claudeErr}`
          : stopReason === 'max_tokens'
            ? 'Claude response was truncated by max_tokens — reduce chunk_days or posts_per_day_per_platform.'
            : 'Claude returned no parseable posts (retry also failed)',
        day_offset: offset,
        stop_reason: stopReason,
        raw_preview: rawLast.slice(0, 400),
      })
    }

    // Insert rows. Per-post we:
    //   1. Pin scheduled_datetime by distributing evenly across the day
    //   2. Set approval_status='pending' so it shows up in the swipe queue
    //   3. Store per_platform_text so the publish path uses the variant
    //      tuned for each platform rather than the generic caption
    const inserted = []
    const failed   = []
    const goalSnippet = String(body.goal || '').slice(0, 400)

    // Bucket posts by date for distribution.
    const byDate = new Map()
    for (const p of posts) {
      const d = String(p?.date || '').slice(0, 10)
      if (!d) continue
      if (!byDate.has(d)) byDate.set(d, [])
      byDate.get(d).push(p)
    }

    for (const day of dayWindow) {
      const key = day.toISOString().slice(0, 10)
      const dayPosts = byDate.get(key) || []
      const slots = distributeDay(day, dayPosts.length, tz)
      for (let i = 0; i < dayPosts.length; i++) {
        const p = dayPosts[i]
        try {
          const row = {
            profile_id: profileId,
            title: String(p.title || '').slice(0, 200) || `${key} post ${i+1}`,
            hook:  String(p.hook  || '').slice(0, 500) || null,
            caption: String(p.caption || '').slice(0, 8000),
            hashtags: capHashtags(String(p.hashtags || '').slice(0, 1000)),
            platforms,
            scheduled_datetime: slots[i] || null,
            status: 'caption_ready',
            approval_status: 'pending',
            needs_approval: true,
            generated_by: 'generate-month',
            generation_prompt: goalSnippet,
            per_platform_text: p.per_platform_text && typeof p.per_platform_text === 'object'
              ? p.per_platform_text : null,
            post_type: 'text',
          // media_type='text' (not the DB default 'video') so the
          // /api/content?action=approve path knows these are text-only
          // posts that should publish via Upload-Post's /upload_text
          // endpoint rather than waiting for media to be attached.
          media_type: 'text',
          }
          const ins = await supaFetch('content_scripts', { method: 'POST', body: row })
          const out = Array.isArray(ins) ? ins[0] : ins
          if (out?.id) inserted.push(out.id)
        } catch (e) {
          failed.push({ date: key, idx: i, error: e?.message || String(e) })
        }
      }
    }

    const nextOffset = offset + dayWindow.length
    const done = nextOffset >= totalDays

    return res.status(200).json({
      phase: 'run',
      inserted,
      failed,
      day_offset: offset,
      next_offset: nextOffset,
      total_days: totalDays,
      done,
    })
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || String(e) })
  }
}
