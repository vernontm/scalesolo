#!/usr/bin/env node
// One-off runner for /api/content/generate-month. Skips the Vercel
// function + browser loop entirely — talks to Supabase + Anthropic
// directly with the service key + Anthropic key from .env. Use to
// resume a content-month run after a tab close (the browser-driven
// loop dies when the tab is backgrounded).
//
// Usage:
//   SUPABASE_URL=… SUPABASE_SERVICE_KEY=… ANTHROPIC_API_KEY=… \
//   node scripts/run-generate-month.mjs \
//     --profile <uuid> \
//     --goal "Drive followers to the AI quiz to convert" \
//     --platforms threads,twitter,instagram,facebook \
//     --posts-per-day 4 \
//     --start 2026-06-14 \
//     --end 2026-06-30
//
// Mirrors the per-day chunk size + JSON parsing + insert logic from
// api/content/generate-month.js. Logs progress per-day to stdout.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { argv, env, exit } from 'node:process'

// ── env auto-load from .env if not set in env directly ────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '..', '.env')
try {
  const raw = readFileSync(envPath, 'utf8')
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i)
    if (!m) continue
    const k = m[1]
    let v = m[2].trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    if (!env[k]) env[k] = v
  }
} catch { /* no .env, fine — caller passed via shell */ }

const SUPABASE_URL = env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
  console.error('Need SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY in env or .env')
  exit(1)
}

// ── args ──────────────────────────────────────────────────────────────
function parseArgs() {
  const a = { profile: null, goal: '', platforms: [], postsPerDay: 4, start: null, end: null }
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--profile') a.profile = argv[++i]
    else if (t === '--goal') a.goal = argv[++i]
    else if (t === '--platforms') a.platforms = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
    else if (t === '--posts-per-day') a.postsPerDay = Number(argv[++i])
    else if (t === '--start') a.start = argv[++i]
    else if (t === '--end') a.end = argv[++i]
  }
  if (!a.profile) throw new Error('--profile required')
  if (!a.platforms.length) throw new Error('--platforms required (comma-separated)')
  if (!a.start || !a.end) throw new Error('--start and --end required (YYYY-MM-DD)')
  return a
}

// ── platform rules (mirror of server) ─────────────────────────────────
const PLATFORM_RULES = {
  threads:   { max: 500,   tone: 'Punchy, short declarative lines. 3-5 lines max. No em dashes. Confident, not hype.' },
  twitter:   { max: 280,   tone: 'One tight idea per post. Lead with the punchline.' },
  instagram: { max: 2200,  tone: 'Hook in line 1, breath in line 2, 2-3 supporting beats, then a soft question or invite.' },
  facebook:  { max: 1000,  tone: 'Conversational, slightly longer. Story or insight format.' },
  tiktok:    { max: 2200,  tone: 'High-energy caption that pairs with the video. Hook + payoff.' },
  youtube:   { max: 5000,  tone: 'Description-style. SEO-aware first 150 chars, then expand.' },
  linkedin:  { max: 3000,  tone: 'Professional with personality. End with a question or POV.' },
  bluesky:   { max: 300,   tone: 'Short, casual, network-aware.' },
}

// ── helpers ───────────────────────────────────────────────────────────
async function rest(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  })
  const text = await r.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`)
  return body
}

async function callClaude(system, user) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 16384,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    }),
  })
  const body = await r.json()
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${body?.error?.message || JSON.stringify(body).slice(0, 300)}`)
  return body
}

function safeParseJsonArray(raw) {
  if (!raw) return []
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try { const p = JSON.parse(cleaned); return Array.isArray(p) ? p : [] } catch {}
  const m = cleaned.match(/\[[\s\S]*\]/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  // Truncation recovery
  const start = cleaned.indexOf('[')
  const lastClose = cleaned.lastIndexOf('}')
  if (start >= 0 && lastClose > start) {
    try { const p = JSON.parse(cleaned.slice(start, lastClose + 1) + ']'); return Array.isArray(p) ? p : [] } catch {}
  }
  return []
}

function truncate(s, n) { return String(s || '').slice(0, n).replace(/\s+/g, ' ').trim() }

function buildBrandMarkdown(ctx) {
  const out = []
  const p = ctx.profile || {}
  if (p.business_name) out.push(`## Brand: ${p.business_name}`)
  if (p.preferred_tone) out.push(`Voice: ${p.preferred_tone}`)
  if (p.target_audience) out.push(`Audience: ${p.target_audience}`)
  if (p.brand_bible) {
    out.push('\n## Brand bible')
    out.push(truncate(p.brand_bible, 1800))
  }
  if (ctx.voiceSummary?.summary) {
    out.push('\n## Voice summary')
    out.push(ctx.voiceSummary.summary)
  }
  if (Array.isArray(ctx.refScripts) && ctx.refScripts.length) {
    out.push('\n## Exemplar posts (write in this style)')
    for (const s of ctx.refScripts.slice(0, 5)) {
      out.push(`- ${truncate(s.text, 300)}`)
    }
  }
  if (Array.isArray(p.do_not_say) && p.do_not_say.length) {
    out.push('\n## DO NOT use these words/phrases')
    out.push(p.do_not_say.map((s) => `"${truncate(s, 80)}"`).join(', '))
  }
  if (Array.isArray(ctx.visualReferences) && ctx.visualReferences.length) {
    out.push('\n## Visual references (mirror these patterns)')
    for (const r of ctx.visualReferences.slice(0, 10)) {
      const bits = [`${r.kind}: ${r.public_url}`]
      if (r.notes) bits.push(`note: "${truncate(r.notes, 200)}"`)
      out.push(`- ${bits.join(' — ')}`)
    }
  }
  return out.join('\n')
}

function buildSystem(ctx, opts) {
  const brand = buildBrandMarkdown(ctx)
  const platformList = opts.platforms
    .map((p) => `- ${p} (max ${PLATFORM_RULES[p]?.max ?? 1000} chars): ${PLATFORM_RULES[p]?.tone ?? 'Default brand voice.'}`)
    .join('\n')
  return `You are this brand's social content strategist. You write posts that read like the brand wrote them — never generic AI copy.

${brand}

## Monthly content goal
${opts.goal || 'Drive engagement and consistent presence.'}

## Platforms you'll write for
${platformList}

## Output rules — read carefully
- Respond with ONLY a JSON array. No markdown, no commentary, no preface.
- Each element is one post object: { "date": "YYYY-MM-DD", "title": "<3-9 word headline in Title Case, surfaces on Facebook>", "hook", "caption", "hashtags", "per_platform_text": { platform: text, ... } }
- per_platform_text MUST include an entry for EVERY platform listed above with distinct wording per platform.
- Vary post structures across the day: list, story, question, hot take. Never repeat opening patterns within 3 days.
- Never use em dashes. No emojis unless brand exemplars use them.
- Return ONLY the JSON array. Start with [ and end with ].`
}

function buildUser(date, postsPerDay, platforms) {
  return `Generate ${postsPerDay} posts for the date ${date.toISOString().slice(0,10)}.

Each post must include per_platform_text covering: ${platforms.join(', ')}.

Vary angles — same brand, different lenses (educational, contrarian, personal, BTS, win-share).`
}

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

// ── main ──────────────────────────────────────────────────────────────
async function main() {
  const { profile, goal, platforms, postsPerDay, start, end } = parseArgs()

  console.log(`[gen-month] profile=${profile} platforms=${platforms.join(',')} posts/day=${postsPerDay} ${start}→${end}`)

  // Load brand context with one parallel batch of REST calls.
  const [profileRow, refScripts, voiceSummary, visualReferences] = await Promise.all([
    rest(`/profiles?id=eq.${profile}&select=*`).then((r) => r?.[0] || {}),
    rest(`/brand_scripts?profile_id=eq.${profile}&rating=gte.0&order=rating.desc&limit=8&select=text,hook,rating,notes`).catch(() => []),
    rest(`/brand_voice_summaries?profile_id=eq.${profile}&is_active=eq.true&order=created_at.desc&limit=1&select=summary,liked_patterns,disliked_patterns`).then((r) => r?.[0] || null).catch(() => null),
    rest(`/brand_visual_references?profile_id=eq.${profile}&order=created_at.desc&limit=24&select=kind,public_url,notes,caption`).catch(() => []),
  ])
  const ctx = { profile: profileRow, refScripts, voiceSummary, visualReferences }
  const system = buildSystem(ctx, { platforms, goal })

  // Persist the goal back on the profile so future opens of the modal
  // pre-fill it.
  if (goal) {
    await rest(`/profiles?id=eq.${profile}`, {
      method: 'PATCH', body: JSON.stringify({ monthly_content_goal: goal.slice(0, 4000) }),
    }).catch(() => {})
  }

  const startD = new Date(`${start}T00:00:00`)
  const endD   = new Date(`${end}T23:59:59`)
  const days = []
  for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d))
  }
  console.log(`[gen-month] ${days.length} days to process`)

  let inserted = 0
  let failed = 0
  for (const day of days) {
    const key = day.toISOString().slice(0, 10)
    const user = buildUser(day, postsPerDay, platforms)
    let posts = []
    for (const attempt of [user, `${user}\n\n# FINAL REMINDER\nReturn ONLY a valid JSON array. No prose, no markdown.`]) {
      try {
        const resp = await callClaude(system, attempt)
        const raw = resp?.content?.find?.((c) => c.type === 'text')?.text || ''
        posts = safeParseJsonArray(raw)
        if (posts.length) break
      } catch (e) {
        console.warn(`  ! ${key} claude error: ${e.message}`)
      }
    }
    if (!posts.length) {
      console.warn(`  ✗ ${key} — no parseable posts after retry`)
      failed++
      continue
    }
    const slots = distributeDay(day, posts.length)
    let dayInserted = 0
    for (let i = 0; i < posts.length; i++) {
      const p = posts[i]
      try {
        const row = {
          profile_id: profile,
          title: String(p.title || '').slice(0, 200) || `${key} post ${i+1}`,
          hook: String(p.hook || '').slice(0, 500) || null,
          caption: String(p.caption || '').slice(0, 8000),
          hashtags: String(p.hashtags || '').slice(0, 1000) || null,
          platforms,
          scheduled_datetime: slots[i] || null,
          status: 'caption_ready',
          approval_status: 'pending',
          needs_approval: true,
          generated_by: 'generate-month',
          generation_prompt: goal.slice(0, 400),
          per_platform_text: p.per_platform_text && typeof p.per_platform_text === 'object' ? p.per_platform_text : null,
          post_type: 'text',
          media_type: 'text',
        }
        await rest('/content_scripts', { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'return=minimal' } })
        dayInserted++
        inserted++
      } catch (e) {
        console.warn(`    ! insert error ${key} #${i}: ${e.message.slice(0, 120)}`)
      }
    }
    console.log(`  ✓ ${key}: ${dayInserted}/${posts.length} posts inserted (running total ${inserted})`)
  }

  console.log(`[gen-month] done — inserted=${inserted} failed_days=${failed}`)
}

main().catch((e) => { console.error(e); exit(1) })
