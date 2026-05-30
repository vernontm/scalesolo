#!/usr/bin/env node
// Retrofit existing content_scripts rows with brand CTAs.
//
// For each row matched by --profile/--generated-by/--filter, runs a
// small Claude pass to pick the best-fit CTA from profiles.brand_ctas
// based on the post's hook + caption, then appends a clean
// "{label}: {url}" line to caption + every per_platform_text variant
// (each trimmed to that platform's char limit).
//
// Skips rows whose caption already mentions any of the URLs — re-runs
// are safe and idempotent. Batches posts in groups so we make one
// Claude call per N posts instead of one per post.
//
// Usage:
//   SUPABASE_URL=… SUPABASE_SERVICE_KEY=… ANTHROPIC_API_KEY=… \
//   node scripts/retrofit-content-ctas.mjs \
//       --profile <uuid> \
//       --generated-by generate-month \
//       --batch 8

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { argv, env, exit } from 'node:process'

// Auto-load .env from repo root and the actual project root (the
// worktree's .env might not exist; the real one lives a few levels up).
const __dirname = dirname(fileURLToPath(import.meta.url))
for (const candidate of [
  join(__dirname, '..', '.env'),
  join(__dirname, '..', '..', '..', '..', '..', '.env'),
]) {
  try {
    const raw = readFileSync(candidate, 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i)
      if (!m) continue
      const v = m[2].trim().replace(/^"(.*)"$/, '$1')
      if (!env[m[1]]) env[m[1]] = v
    }
  } catch { /* missing, try next */ }
}

const SUPABASE_URL = env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
  console.error('Need SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY in env or .env')
  exit(1)
}

function parseArgs() {
  const a = { profile: null, generatedBy: 'generate-month', batch: 8, limit: null, only: null }
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--profile') a.profile = argv[++i]
    else if (t === '--generated-by') a.generatedBy = argv[++i]
    else if (t === '--batch') a.batch = Math.max(1, Math.min(20, Number(argv[++i])))
    else if (t === '--limit') a.limit = Number(argv[++i])
    else if (t === '--only') a.only = argv[++i] // 'pending' | 'approved' etc
  }
  if (!a.profile) throw new Error('--profile required')
  return a
}

const PLATFORM_MAX = {
  threads: 500, twitter: 280, instagram: 2200, facebook: 1000,
  tiktok: 2200, youtube: 5000, linkedin: 3000, bluesky: 300,
}

async function rest(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
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
      max_tokens: 4096,
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
  const start = cleaned.indexOf('[')
  const lastClose = cleaned.lastIndexOf('}')
  if (start >= 0 && lastClose > start) {
    try { return JSON.parse(cleaned.slice(start, lastClose + 1) + ']') } catch {}
  }
  return []
}

function alreadyHasAnyCta(text, ctaUrls) {
  if (!text) return false
  const lc = String(text).toLowerCase()
  return ctaUrls.some((u) => lc.includes(String(u).toLowerCase()))
}

function appendCta(text, label, url, max) {
  if (!text) return `${label}: ${url}`
  const base = String(text).trimEnd()
  const suffix = `\n\n${label}: ${url}`
  // If adding the suffix overruns the platform cap, trim the body to fit.
  const total = base.length + suffix.length
  if (max && total > max) {
    const budget = Math.max(0, max - suffix.length - 1)
    return `${base.slice(0, budget).trimEnd()}${suffix}`
  }
  return `${base}${suffix}`
}

async function main() {
  const { profile, generatedBy, batch, limit, only } = parseArgs()

  // 1. Load the CTAs from the profile.
  const profRow = await rest(`/profiles?id=eq.${profile}&select=brand_ctas`).then((r) => r?.[0])
  const ctas = Array.isArray(profRow?.brand_ctas) ? profRow.brand_ctas : []
  if (!ctas.length) {
    console.error(`No brand_ctas configured on profile ${profile}. Set profiles.brand_ctas first.`)
    exit(1)
  }
  const ctaUrls = ctas.map((c) => c.url)
  console.log(`[retrofit] profile=${profile} CTAs available: ${ctaUrls.join(', ')}`)

  // 2. Pull matching rows. Filter out anything that already has a CTA in caption.
  let query = `/content_scripts?profile_id=eq.${profile}&generated_by=eq.${encodeURIComponent(generatedBy)}&select=id,hook,caption,per_platform_text,platforms,approval_status&order=scheduled_datetime.asc.nullslast`
  if (only) query += `&approval_status=eq.${encodeURIComponent(only)}`
  if (limit) query += `&limit=${limit}`
  const rows = await rest(query)
  const todo = rows.filter((r) => !alreadyHasAnyCta(r.caption, ctaUrls))
  console.log(`[retrofit] fetched ${rows.length} rows, ${todo.length} need CTAs (rest already have them)`)
  if (!todo.length) { console.log('Nothing to do.'); return }

  // 3. Build system prompt — one for the whole run, cached.
  const ctaList = ctas.map((c, i) => `${i}. "${c.label}" → ${c.url}\n   Best fit: ${c.when}`).join('\n')
  const system = `You assign CTAs to social posts. Each post gets exactly one CTA, picked from the list below to match the post's intent.

## Available CTAs
${ctaList}

## Output rules
- Respond with ONLY a JSON array. Each element: { "id": "<post_id>", "cta_index": <integer> }.
- cta_index is the number of the CTA from the list above.
- No commentary, no markdown fences. Start with [ and end with ].`

  // 4. Process in batches — Claude picks the CTA index for each post.
  let updated = 0
  let skipped = 0
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch)
    const userParts = chunk.map((p) => {
      const hook = String(p.hook || '').slice(0, 200)
      const cap  = String(p.caption || '').slice(0, 400)
      return `id: ${p.id}\nhook: ${hook}\ncaption: ${cap}`
    })
    const user = `Pick the best CTA for each of these posts:\n\n${userParts.join('\n\n---\n\n')}\n\nReturn JSON array.`
    let picks = []
    try {
      const resp = await callClaude(system, user)
      const raw = resp?.content?.find?.((c) => c.type === 'text')?.text || ''
      picks = safeParseJsonArray(raw)
    } catch (e) {
      console.warn(`  ! batch ${i}-${i+chunk.length} Claude error: ${e.message}`)
    }
    const byId = new Map(picks.map((p) => [p.id, p.cta_index]))
    for (const post of chunk) {
      const idx = byId.has(post.id) ? Number(byId.get(post.id)) : 0
      const cta = ctas[idx] ?? ctas[0]
      try {
        const platforms = Array.isArray(post.platforms) ? post.platforms : []
        // Caption (generic body) — no per-platform cap.
        const newCaption = appendCta(post.caption, cta.label, cta.url, null)
        // Per-platform variants — each trimmed to its cap.
        const ppt = (post.per_platform_text && typeof post.per_platform_text === 'object')
          ? { ...post.per_platform_text } : {}
        for (const plat of platforms) {
          const cap = PLATFORM_MAX[plat] || null
          ppt[plat] = appendCta(ppt[plat], cta.label, cta.url, cap)
        }
        await rest(`/content_scripts?id=eq.${post.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            caption: newCaption,
            per_platform_text: ppt,
          }),
        })
        updated++
        process.stdout.write(`\r[retrofit] updated ${updated}/${todo.length}    `)
      } catch (e) {
        skipped++
        console.warn(`\n  ! ${post.id}: ${e.message.slice(0, 120)}`)
      }
    }
  }
  console.log(`\n[retrofit] done — updated=${updated} skipped=${skipped}`)
}

main().catch((e) => { console.error(e); exit(1) })
