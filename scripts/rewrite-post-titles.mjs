#!/usr/bin/env node
// Rewrite content_scripts.title from slug-form to real headline titles
// suitable for Facebook's post title field. The generation pass writes
// slugs like "ai-template-trap" which are fine internally but ugly when
// surfaced on platforms that expose the title separately from the body.
//
// We batch posts in groups of 10 and ask Claude to produce a short
// (3-9 words) headline-cased title per post, grounded in its hook +
// caption. Re-runs are idempotent on rows whose title already contains
// a space (i.e. already a real title) — those get skipped.
//
// Usage:
//   SUPABASE_URL=… SUPABASE_SERVICE_KEY=… ANTHROPIC_API_KEY=… \
//   node scripts/rewrite-post-titles.mjs \
//       --profile <uuid> \
//       --generated-by generate-month \
//       --batch 10

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { argv, env, exit } from 'node:process'

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
  } catch {}
}

const SUPABASE_URL = env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
  console.error('Need SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY in env or .env')
  exit(1)
}

function parseArgs() {
  const a = { profile: null, generatedBy: 'generate-month', batch: 10 }
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--profile') a.profile = argv[++i]
    else if (t === '--generated-by') a.generatedBy = argv[++i]
    else if (t === '--batch') a.batch = Math.max(1, Math.min(20, Number(argv[++i])))
  }
  if (!a.profile) throw new Error('--profile required')
  return a
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
      max_tokens: 2048,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    }),
  })
  const body = await r.json()
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${body?.error?.message || JSON.stringify(body).slice(0, 300)}`)
  return body
}

function parseJsonArray(raw) {
  if (!raw) return []
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try { const p = JSON.parse(cleaned); return Array.isArray(p) ? p : [] } catch {}
  const m = cleaned.match(/\[[\s\S]*\]/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  return []
}

// Heuristic for "is this already a real title or still a slug?". Slugs
// have no spaces and use dashes. Real titles have at least one space.
function isSlug(s) {
  if (!s) return true
  const t = String(s).trim()
  if (!t) return true
  return !t.includes(' ')
}

async function main() {
  const { profile, generatedBy, batch } = parseArgs()
  const rows = await rest(
    `/content_scripts?profile_id=eq.${profile}&generated_by=eq.${encodeURIComponent(generatedBy)}` +
    '&select=id,title,hook,caption&order=scheduled_datetime.asc.nullslast'
  )
  const todo = rows.filter((r) => isSlug(r.title))
  console.log(`[titles] ${rows.length} rows fetched, ${todo.length} need real titles`)
  if (!todo.length) return

  const system = `You write tight, human headlines for social posts. For each post given to you, produce a SHORT title (3-9 words, Title Case, no trailing period, no quotes) that captures the core idea of the post. Titles surface on Facebook + appear as the post's name in the dashboard, so they should read like real magazine headlines, not slugs or summaries.

## Output rules
- Respond with ONLY a JSON array of objects.
- Each object: { "id": "<post_id>", "title": "<3-9 word title>" }.
- No commentary, no markdown fences. Start with [ end with ].`

  let updated = 0
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch)
    const userParts = chunk.map((p) => {
      const hook = String(p.hook || '').slice(0, 200)
      const cap  = String(p.caption || '').slice(0, 350)
      return `id: ${p.id}\nhook: ${hook}\ncaption: ${cap}`
    })
    const user = `Generate a real title for each of these posts:\n\n${userParts.join('\n\n---\n\n')}\n\nReturn JSON array.`
    let titles = []
    try {
      const resp = await callClaude(system, user)
      const raw = resp?.content?.find?.((c) => c.type === 'text')?.text || ''
      titles = parseJsonArray(raw)
    } catch (e) {
      console.warn(`  ! batch starting at ${i} Claude error: ${e.message}`)
    }
    const byId = new Map(titles.map((t) => [t.id, String(t.title || '').trim()]))
    for (const post of chunk) {
      const newTitle = byId.get(post.id)
      if (!newTitle || newTitle.length < 3 || newTitle.length > 160) continue
      try {
        await rest(`/content_scripts?id=eq.${post.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ title: newTitle }),
        })
        updated++
        process.stdout.write(`\r[titles] updated ${updated}/${todo.length}    `)
      } catch (e) {
        console.warn(`\n  ! ${post.id}: ${e.message.slice(0, 120)}`)
      }
    }
  }
  console.log(`\n[titles] done — updated=${updated}`)
}

main().catch((e) => { console.error(e); exit(1) })
