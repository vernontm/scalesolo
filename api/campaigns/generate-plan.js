// POST /api/campaigns/generate-plan?phase=preview|run
//
// Campaign-aware sibling of api/content/generate-month.js. Reads a
// campaign row for its config (duration, posts/day, specials, standouts,
// content mix, holidays, goal) and generates a day-by-day PLAN of posts
// as content_scripts rows tagged with campaign_id + a per-post
// media_brief. Phase 1 produces the reviewable plan (captions + briefs);
// media generation (images/carousels/videos) is a later phase that
// consumes media_brief.
//
// Two phases, chunked, resumable — identical control flow to
// generate-month so the wizard can preview cost then loop run chunks:
//   ?phase=preview → { total_days, total_posts, chunks, estimated_cost_usd }
//   ?phase=run     → { inserted, next_offset, done }  (loop until done)
//
// Body:
//   { campaign_id, platforms: [...], day_offset?, chunk_days? }
// platforms come from the wizard (the client's Upload-Post-connected
// set); everything else is read from the campaign row.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'
import { message as anthropicMessage } from '../_lib/anthropic.js'

export const config = { maxDuration: 300 }

const VALID_PLATFORMS = new Set([
  'threads', 'instagram', 'x', 'facebook',
  'tiktok', 'youtube', 'linkedin', 'pinterest', 'bluesky', 'reddit',
])
const PLATFORM_ALIASES = { twitter: 'x' }
const normalizePlatform = (p) => {
  const s = String(p || '').toLowerCase()
  return PLATFORM_ALIASES[s] || s
}

const PLATFORM_RULES = {
  threads:   { max: 500,  tone: 'Punchy, short declarative lines. 3-5 lines max. No em dashes.' },
  x:         { max: 280,  tone: 'One tight idea. Lead with the punchline.' },
  instagram: { max: 2200, tone: 'Hook line 1, breath line 2, 2-3 beats, soft invite.' },
  facebook:  { max: 1000, tone: 'Conversational, slightly longer. Story or insight.' },
  tiktok:    { max: 2200, tone: 'High-energy caption paired with the video. Hook + payoff.' },
  youtube:   { max: 5000, tone: 'Description-style. SEO-aware first 150 chars.' },
  linkedin:  { max: 3000, tone: 'Professional with personality. End with a POV.' },
  pinterest: { max: 800,  tone: 'SEO-keyword forward. Describe the value.' },
  bluesky:   { max: 300,  tone: 'Short, casual. Skip hashtags.' },
  reddit:    { max: 300,  tone: 'Title is everything. Question or hot-take.' },
}

const SONNET_IN_PER_MTOK  = 3.00
const SONNET_OUT_PER_MTOK = 15.00

const WEEKDAY_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

// content_type → the content_scripts.media_type stored on the row.
const MEDIA_TYPE_FOR = {
  text: 'text', promo: 'image', mood: 'image', image: 'image',
  carousel: 'carousel', video: 'video',
}

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x }
function isoDay(d) { return d.toISOString().slice(0, 10) }

function distributeDay(date, count) {
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

// Which specials apply to a given date. Weekly specials match by weekday
// code (['wed']); one-off specials match by ISO date.
function specialsForDate(date, specials) {
  const code = WEEKDAY_CODES[date.getDay()]
  const iso = isoDay(date)
  return (Array.isArray(specials) ? specials : []).filter((s) => {
    if (!s) return false
    if (s.date && String(s.date).slice(0, 10) === iso) return true
    if ((s.cadence === 'weekly' || !s.cadence) && Array.isArray(s.days)) {
      return s.days.map((d) => String(d).toLowerCase().slice(0, 3)).includes(code)
    }
    return false
  })
}

function holidaysForDate(date, holidays) {
  const iso = isoDay(date)
  return (Array.isArray(holidays) ? holidays : []).filter((h) => h && String(h.date).slice(0, 10) === iso)
}

// Compact catalog of the brand's real assets for the prompt, so the
// model can pick reference_asset_ids by what each asset actually shows.
function buildAssetCatalog(assets) {
  if (!assets?.length) return ''
  const lines = assets.slice(0, 40).map((a) => {
    const subj = a.vision_json?.subject || a.label || a.category
    const details = Array.isArray(a.vision_json?.key_details) ? a.vision_json.key_details.slice(0, 3).join('; ') : ''
    return `- id:${a.id} [${a.media_type}/${a.category}] ${a.label || subj}${details ? ` (${details})` : ''}`
  })
  return `\n## Real brand assets you can reference (use their ids in media_brief.reference_asset_ids)\nThese are the client's ACTUAL photos/videos. Any post that shows the real product MUST reference the best-matching asset id so the media is generated from it and stays exact. Do not invent products we do not have assets for.\n${lines.join('\n')}`
}

function buildContentMixBlock(mix) {
  const entries = Object.entries(mix || {}).filter(([, v]) => Number(v) > 0)
  if (!entries.length) return ''
  const total = entries.reduce((s, [, v]) => s + Number(v), 0)
  const pretty = entries.map(([k, v]) => `${k} (~${Math.round((v / total) * 100)}%)`).join(', ')
  return `\n## Content-type mix (approximate target across the whole campaign)\n${pretty}\nAssign each post a content_type from: carousel, image, video, promo, mood, text. Honor the mix across the campaign, not within a single day. carousel = a multi-slide post (set "slides" 3-6) that still counts as ONE post. mood = an atmosphere/lifestyle piece (e.g. cozy, romantic). promo = built around a special/holiday.`
}

function buildSystemPrompt(ctx, { campaign, platforms, assets }) {
  const brand = renderBrandContextMarkdown(ctx, {
    include: ['identity', 'bible', 'summary', 'exemplars', 'hooks', 'bad_patterns', 'rules', 'visual_refs'],
    bibleCharLimit: 1800,
    visualRefKinds: ['threads', 'carousel', 'graphic'],
  })
  const platformList = platforms
    .map((p) => `- ${p} (max ${PLATFORM_RULES[p]?.max ?? 1000} chars): ${PLATFORM_RULES[p]?.tone ?? 'Default brand voice.'}`)
    .join('\n')

  const standouts = Array.isArray(campaign.standouts) ? campaign.standouts.filter(Boolean) : []
  const standoutBlock = standouts.length
    ? `\n## Brand standout selling points — weave these in naturally across the campaign\n${standouts.map((s) => `- ${s}`).join('\n')}`
    : ''

  const ctas = Array.isArray(ctx?.profile?.brand_ctas) ? ctx.profile.brand_ctas : []
  const ctaBlock = ctas.length
    ? `\n## CTAs — pick the best-fit URL per post\n${ctas.map((c, i) => `${i + 1}. "${c.label}" → ${c.url} (best fit: ${c.when || 'general'})`).join('\n')}\n**Every post ends with one CTA** on its own line as "{label}: {url}", applied to caption AND each per_platform_text variant, trimmed to fit each cap.`
    : ''

  return `You are this brand's campaign content strategist. You write posts that read like the brand wrote them, and you plan a coherent mixed-media campaign.

${brand}

## Campaign goal
${String(campaign.goal || '').trim() || 'Drive foot traffic, orders, and consistent presence; reinforce what makes this brand special.'}

## Platforms you'll write for
${platformList}${standoutBlock}${buildContentMixBlock(campaign.content_mix)}${buildAssetCatalog(assets)}${ctaBlock}

## Output rules — read carefully
- Respond with ONLY a JSON array. No markdown, no commentary, no preface.
- Each element is one post object:
  {
    "date": "YYYY-MM-DD",
    "content_type": "carousel" | "image" | "video" | "promo" | "mood" | "text",
    "slides": <int 3-6, ONLY for carousel, else omit>,
    "title": "<3-9 word Title Case headline>",
    "hook": "<opening line, brand voice>",
    "caption": "<base text, 250-450 chars total. Hook line, 1-2 beats, one closer.>",
    "hashtags": "<space-separated, max 8>",
    "per_platform_text": { ${platforms.map((p) => `"${p}": "..."`).join(', ')} },
    "media_brief": {
      "prompt": "<for non-text posts: a concrete visual generation brief. Describe the shot. If it shows the real product, say to keep it EXACT.>",
      "reference_asset_ids": ["<asset ids from the catalog that this media is built from; [] for text>"],
      "exact_lock": <true when the post shows the real product/food and must match the reference exactly, else false>
    }
  }
- per_platform_text MUST include EVERY platform above, written slightly differently for each, trimmed to each cap.
- When a date has a SPECIAL or HOLIDAY noted in the user message, make at least one of that day's posts a promo/graphic tied to it.
- For content_type text, media_brief may be { "prompt": "", "reference_asset_ids": [], "exact_lock": false }.
- Never use em dashes. No emojis unless the brand exemplars use them.
- Each post stands alone. Return ONLY the JSON array — start with [ and end with ].`
}

function buildUserPrompt(dayWindow, postsPerDay, platforms, campaign) {
  const lines = dayWindow.map((d) => {
    const specials = specialsForDate(d, campaign.specials)
    const hols = holidaysForDate(d, campaign.holidays)
    const tags = [
      ...specials.map((s) => `SPECIAL: ${s.title}${s.discount_pct ? ` (${s.discount_pct}% off)` : ''}${s.note ? ` — ${s.note}` : ''}`),
      ...hols.map((h) => `HOLIDAY: ${h.name}`),
    ]
    return `- ${isoDay(d)} (${WEEKDAY_CODES[d.getDay()]})${tags.length ? ` → ${tags.join(' | ')}` : ''}`
  })
  return `Generate ${postsPerDay} post(s) for EACH of these dates (${postsPerDay * dayWindow.length} posts total):
${lines.join('\n')}

Each post needs per_platform_text for all of: ${platforms.join(', ')}. Vary the angles and content types across days to honor the campaign mix. Where a date is tagged SPECIAL or HOLIDAY, tie at least one post that day to it.`
}

function safeParseJsonArray(raw) {
  if (!raw) return []
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    const m = cleaned.match(/\[[\s\S]*\]/)
    if (m) { try { return JSON.parse(m[0]) } catch { /* recover */ } }
    const arrStart = cleaned.indexOf('[')
    if (arrStart >= 0) {
      const lastClose = cleaned.lastIndexOf('}')
      if (lastClose > arrStart) {
        try {
          const parsed = JSON.parse(cleaned.slice(arrStart, lastClose + 1) + ']')
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
    const campaignId = body.campaign_id
    if (!campaignId) return res.status(400).json({ error: 'campaign_id required' })

    const campRows = await supaFetch(`campaigns?id=eq.${campaignId}&limit=1`)
    const campaign = campRows?.[0]
    if (!campaign) return res.status(404).json({ error: 'campaign not found' })
    await assertProfileAccess(auth.user.id, campaign.profile_id)
    const profileId = campaign.profile_id

    const platforms = (Array.isArray(body.platforms) ? body.platforms : [])
      .map(normalizePlatform)
      .filter((p) => VALID_PLATFORMS.has(p))
    if (!platforms.length) return res.status(400).json({ error: 'at least one valid platform required' })

    const postsPerDay = Math.max(1, Math.min(10, Number(campaign.posts_per_day || 1)))
    const totalDays = Math.max(1, Math.min(90, Number(campaign.duration_days || 7)))
    const startDate = startOfDay(campaign.start_date ? new Date(`${campaign.start_date}T00:00:00`) : new Date())
    const totalPosts = totalDays * postsPerDay
    const phase = String(req.query.phase || 'preview')

    // ── PREVIEW ───────────────────────────────────────────────────
    if (phase === 'preview') {
      const chunkDays = Math.max(1, Math.min(7, Number(body.chunk_days || 1)))
      const chunks = Math.ceil(totalDays / chunkDays)
      const inTotal = 5000 + (chunks - 1) * 800
      const postsPerChunk = chunkDays * postsPerDay
      const outTotal = chunks * postsPerChunk * platforms.length * 280
      const costUsd =
        (inTotal / 1_000_000) * SONNET_IN_PER_MTOK +
        (outTotal / 1_000_000) * SONNET_OUT_PER_MTOK
      return res.status(200).json({
        phase: 'preview',
        start_date: isoDay(startDate),
        total_days: totalDays,
        posts_per_day: postsPerDay,
        platforms,
        total_posts: totalPosts,
        chunk_days: chunkDays,
        chunks,
        estimated_cost_usd: Number(costUsd.toFixed(2)),
        estimated_seconds: Math.ceil(chunks * 20),
      })
    }

    if (phase !== 'run') return res.status(400).json({ error: 'phase must be preview or run' })

    const offset = Math.max(0, Number(body.day_offset || 0))
    const chunkDays = Math.max(1, Math.min(7, Number(body.chunk_days || 1)))

    // Mark the campaign in-flight on the first chunk.
    if (offset === 0) {
      await supaFetch(`campaigns?id=eq.${campaignId}`, {
        method: 'PATCH', body: { status: 'planning', updated_at: new Date().toISOString() }, prefer: 'return=minimal',
      }).catch(() => {})
    }

    const dayWindow = []
    for (let i = 0; i < chunkDays && (offset + i) < totalDays; i++) dayWindow.push(addDays(startDate, offset + i))
    if (!dayWindow.length) {
      return res.status(200).json({ phase: 'run', inserted: [], failed: [], next_offset: totalDays, done: true })
    }

    const [ctx, assets] = await Promise.all([
      loadBrandContext(profileId),
      supaFetch(`brand_assets?profile_id=eq.${profileId}&select=id,media_type,category,label,vision_json&order=created_at.desc&limit=60`).catch(() => []),
    ])
    const validAssetIds = new Set((assets || []).map((a) => a.id))
    const system = buildSystemPrompt(ctx, { campaign, platforms, assets })
    const user   = buildUserPrompt(dayWindow, postsPerDay, platforms, campaign)

    const attempts = [
      user,
      `${user}\n\n# FINAL REMINDER\nReturn ONLY a valid JSON array. No prose. Start with [ and end with ].`,
    ]
    let posts = []
    let stopReason = null
    let rawLast = ''
    let claudeErr = null
    for (let attempt = 0; attempt < attempts.length; attempt++) {
      try {
        const resp = await anthropicMessage({
          system,
          messages: [{ role: 'user', content: attempts[attempt] }],
          max_tokens: 16384,
        })
        rawLast = resp?.content?.find?.((c) => c.type === 'text')?.text || ''
        stopReason = resp?.stop_reason
        posts = safeParseJsonArray(rawLast)
        if (posts.length) break
      } catch (e) { claudeErr = e }
    }
    if (!posts.length) {
      return res.status(502).json({
        error: claudeErr
          ? `Claude call failed: ${claudeErr?.message || claudeErr}`
          : stopReason === 'max_tokens'
            ? 'Claude response was truncated — reduce chunk_days or posts_per_day.'
            : 'Claude returned no parseable posts (retry also failed)',
        day_offset: offset,
        stop_reason: stopReason,
        raw_preview: rawLast.slice(0, 400),
      })
    }

    const inserted = []
    const failed = []
    const byDate = new Map()
    for (const p of posts) {
      const d = String(p?.date || '').slice(0, 10)
      if (!d) continue
      if (!byDate.has(d)) byDate.set(d, [])
      byDate.get(d).push(p)
    }

    for (const day of dayWindow) {
      const key = isoDay(day)
      const dayPosts = byDate.get(key) || []
      const slots = distributeDay(day, dayPosts.length)
      const specials = specialsForDate(day, campaign.specials)
      const hols = holidaysForDate(day, campaign.holidays)
      for (let i = 0; i < dayPosts.length; i++) {
        const p = dayPosts[i]
        try {
          const contentType = MEDIA_TYPE_FOR[p.content_type] ? p.content_type : 'text'
          const mediaType = MEDIA_TYPE_FOR[contentType] || 'text'
          // Sanitize reference_asset_ids against the real catalog so a
          // hallucinated id can't poison later media generation.
          const refIds = Array.isArray(p.media_brief?.reference_asset_ids)
            ? p.media_brief.reference_asset_ids.filter((id) => validAssetIds.has(id))
            : []
          const mediaBrief = {
            content_type: contentType,
            prompt: String(p.media_brief?.prompt || '').slice(0, 2000),
            reference_asset_ids: refIds,
            exact_lock: p.media_brief?.exact_lock !== false && refIds.length > 0,
            slides: contentType === 'carousel' ? Math.max(3, Math.min(6, Number(p.slides) || 3)) : null,
            holiday: hols[0]?.name || null,
            special: specials[0]?.title || null,
          }
          const row = {
            profile_id: profileId,
            campaign_id: campaignId,
            title: String(p.title || '').slice(0, 200) || `${key} post ${i + 1}`,
            hook: String(p.hook || '').slice(0, 500) || null,
            caption: String(p.caption || '').slice(0, 8000),
            hashtags: String(p.hashtags || '').slice(0, 1000) || null,
            platforms,
            scheduled_datetime: slots[i] || null,
            status: 'caption_ready',
            approval_status: 'pending',
            needs_approval: true,
            generated_by: 'campaign',
            generation_prompt: String(campaign.goal || '').slice(0, 400),
            per_platform_text: p.per_platform_text && typeof p.per_platform_text === 'object' ? p.per_platform_text : null,
            post_type: 'post',
            media_type: mediaType,
            media_brief: mediaBrief,
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
    if (done) {
      await supaFetch(`campaigns?id=eq.${campaignId}`, {
        method: 'PATCH', body: { status: 'ready', updated_at: new Date().toISOString() }, prefer: 'return=minimal',
      }).catch(() => {})
    }

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
