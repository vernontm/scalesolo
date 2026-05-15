#!/usr/bin/env node
// Headless "draft the next week of content" job.
//
// Fires on a schedule (launchd / cron). Pulls last week's posts for a
// brand from Supabase, loads the playbook + memory files for that brand,
// then asks Claude to draft the next week's content list — taking into
// account what was just posted, what landed, and what to vary.
//
// Output lands as a timestamped markdown file in
//   ~/Desktop/vtm-content-drafts/week-YYYY-MM-DD.md
// and triggers a macOS Notification Center alert so Ray sees it the
// moment he sits down with coffee.
//
// Usage:
//   node scripts/draft-next-week.mjs --brand vtm
//   node scripts/draft-next-week.mjs --brand sanabreh   (once that brand is set up)
//
// Env (set in ~/.zshrc or in the launchd plist):
//   ANTHROPIC_API_KEY   — Anthropic API key
//   SUPABASE_URL        — https://<ref>.supabase.co
//   SUPABASE_SERVICE_KEY — service-role key (read-only ok for content_scripts)

import { execSync } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

// ── Brand registry ──────────────────────────────────────────────────────────
// One entry per client. Add a new entry to add a new brand to the rotation.
const BRANDS = {
  vtm: {
    label: 'Vernon Tech & Media (rayvaughn.ceo)',
    profile_id: '736be41b-f9d2-4b25-a7fb-dbad86670e77',
    playbook_path: 'docs/vtm-content-playbook.md',
    // Memory files live outside the repo in the user's ~/.claude project
    // memory directory. Listed by absolute path so they survive being
    // moved.
    memory_files: [
      'feedback_vtm_persona.md',
      'feedback_vtm_copy_voice.md',
      'feedback_vtm_threads_examples.md',
      'feedback_vtm_brand_visuals.md',
    ],
  },
  // sanabreh: { ... }  — drop in once the brand profile + playbook exist
}

// ── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const brandIdx = args.indexOf('--brand')
const brandKey = brandIdx >= 0 ? args[brandIdx + 1] : 'vtm'
const brand = BRANDS[brandKey]
if (!brand) {
  console.error(`Unknown brand "${brandKey}". Known: ${Object.keys(BRANDS).join(', ')}`)
  process.exit(1)
}

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
  console.error('Missing env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY')
  process.exit(1)
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const MEMORY_DIR = join(
  homedir(),
  '.claude',
  'projects',
  '-Users-raysmacbook-Desktop-Vernon-Tech-And-Media-Client-Projects-Scalesolo',
  'memory',
)

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

async function fetchLastWeekPosts(profileId) {
  // Pull every content_scripts row from this brand whose scheduled time
  // (or created_at as fallback) fell in the last 7 days. Order newest
  // first so the model can spot the most-recent angle.
  const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const url = `${SUPABASE_URL}/rest/v1/content_scripts`
    + `?profile_id=eq.${profileId}`
    + `&or=(scheduled_datetime.gte.${sinceIso},created_at.gte.${sinceIso})`
    + `&select=id,title,caption,hashtags,media_type,platforms,status,scheduled_datetime,created_at,performance`
    + `&order=scheduled_datetime.desc.nullslast`
    + `&limit=200`
  const r = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  if (!r.ok) throw new Error(`Supabase fetch failed (${r.status}): ${await r.text()}`)
  return r.json()
}

function summarizePosts(rows) {
  if (!rows?.length) return '(no posts in the last 7 days)'
  return rows.map((r, i) => {
    const when = r.scheduled_datetime || r.created_at
    const platforms = Array.isArray(r.platforms) ? r.platforms.join('/') : '—'
    const perf = r.performance && typeof r.performance === 'object'
      ? Object.entries(r.performance).map(([k, v]) => `${k}=${v}`).join(' ')
      : ''
    return [
      `${i + 1}. [${when?.slice(0, 10) || '—'}] (${r.media_type || 'text'}, ${platforms}, status=${r.status})`,
      `   Title: ${r.title || '(no title)'}`,
      r.caption ? `   Caption: ${r.caption.slice(0, 220).replace(/\n+/g, ' ')}${r.caption.length > 220 ? '…' : ''}` : '',
      perf ? `   Performance: ${perf}` : '',
    ].filter(Boolean).join('\n')
  }).join('\n')
}

function loadContext(brand) {
  const playbook = readIfExists(join(REPO_ROOT, brand.playbook_path))
  const memoryBlobs = brand.memory_files.map((f) => {
    const p = join(MEMORY_DIR, f)
    return `### ${f}\n${readIfExists(p) || '(missing)'}`
  }).join('\n\n---\n\n')
  return { playbook, memoryBlobs }
}

// ── Anthropic call ──────────────────────────────────────────────────────────
async function callClaude({ playbook, memoryBlobs, lastWeekSummary, brandLabel }) {
  // The system prompt is the rules the model must obey. The user message
  // is the data + the ask. Keeping rules in system means we can swap
  // tasks later without re-prompting the persona.
  const system = `You are the content director for ${brandLabel}.

Your job is to draft NEXT WEEK's content list, following the playbook and voice rules exactly. Match the voice of the threads that landed — short declarative sentences, the reframe pattern ("X is not Y. X is Z."), self-disclosure, no em-dashes, no contractions, plain language for non-technical solopreneurs.

You do NOT write content that has already been posted this week. You vary the angles, mix in repurposed carousel slides where appropriate, and aim for the cadence specified in the playbook.

Output format: a single markdown table with columns [#, Day, Type, Hook / Title, Platforms, Notes]. After the table, a 3-sentence rationale for why this week's mix builds on last week.

Do NOT write the actual prompts or full captions. Only the list. The user will approve the list and then a follow-up session will write the full copy and patch each post into the canvas.`

  const user = `# Playbook

${playbook}

# Memory files (persona, voice, threads anchors, brand visuals)

${memoryBlobs}

# Last 7 days of posts for ${brandLabel}

${lastWeekSummary}

# Task

Draft the content list for next week (the upcoming 7 days), following the playbook's cadence target and avoiding repeats of what landed in the last 7 days. Lean on the reframe and self-disclosure patterns from the threads anchors. Output the table + rationale, nothing else.`

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`)
  const body = await r.json()
  const text = body?.content?.[0]?.text || ''
  if (!text) throw new Error('Anthropic returned empty text')
  return text
}

// ── Output: write the file + macOS notification ─────────────────────────────
function writeDraft({ brandKey, brandLabel, draft, lastWeekSummary }) {
  const outDir = join(homedir(), 'Desktop', 'vtm-content-drafts')
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const path = join(outDir, `${brandKey}-week-${stamp}.md`)
  const file = `# ${brandLabel} — Next Week Content Draft

Generated: ${new Date().toString()}

## Proposed list

${draft}

---

## What was posted in the last 7 days (for context)

${lastWeekSummary}
`
  writeFileSync(path, file, 'utf8')
  return path
}

function notify(title, message, openPath) {
  // AppleScript notification is the simplest way; if you want it to
  // open the file when clicked, we use `open` after.
  try {
    execSync(`osascript -e 'display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"'`)
  } catch {}
  // Also open the file in the default Markdown editor so Ray sees it
  // immediately when he sits down.
  try { execSync(`open ${JSON.stringify(openPath)}`) } catch {}
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Drafting next week for ${brand.label}…`)
  const { playbook, memoryBlobs } = loadContext(brand)
  if (!playbook) {
    console.error(`Playbook not found at ${brand.playbook_path}`)
    process.exit(1)
  }
  const lastWeek = await fetchLastWeekPosts(brand.profile_id)
  const lastWeekSummary = summarizePosts(lastWeek)
  console.log(`Last week: ${lastWeek.length} posts`)
  const draft = await callClaude({
    playbook,
    memoryBlobs,
    lastWeekSummary,
    brandLabel: brand.label,
  })
  const path = writeDraft({
    brandKey,
    brandLabel: brand.label,
    draft,
    lastWeekSummary,
  })
  console.log(`Wrote draft to ${path}`)
  notify(
    `${brand.label} — next week draft is ready`,
    `Last 7 days: ${lastWeek.length} posts. Draft saved to Desktop/vtm-content-drafts/.`,
    path,
  )
}

main().catch((e) => {
  console.error(e)
  try {
    execSync(`osascript -e 'display notification ${JSON.stringify(e.message)} with title "VTM draft job FAILED" sound name "Basso"'`)
  } catch {}
  process.exit(1)
})
