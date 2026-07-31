#!/usr/bin/env node
// ScaleSolo → iMessage: TikTok Draft caption texter (local Mac agent).
//
// RayvaughnCEO posts TikTok in Draft mode (tiktok_post_mode=MEDIA_UPLOAD): at
// the scheduled time the post lands in the TikTok inbox/drafts to publish
// natively from the app. TikTok DROPS the caption/hashtags in that mode, so
// this agent texts them to you the moment a draft goes live, ready to paste.
//
// Runs on a launchd timer (see the .plist). Each run:
//   1. Pulls the brand's scheduled/posted calendar items from ScaleSolo.
//   2. Keeps TikTok posts whose scheduled time is within the last WINDOW_MIN.
//   3. Texts the title + caption + hashtags via iMessage (AppleScript).
//   4. Records the id so it never double-texts.
//
// Runs entirely on your Mac — it only fires while the Mac is awake/online.
//
// Config: env vars, or a `texter.env` file next to this script, or
// ~/.scalesolo/texter.env (KEY=VALUE lines). Never commit the env file — it
// holds the impersonation secret.
//   SCALESOLO_INTERNAL_SECRET   the MCP/internal secret (same one the MCP uses)
//   SCALESOLO_USER_ID           the ScaleSolo auth user to act as
//   SCALESOLO_PROFILE_ID        the brand profile id (RayvaughnCEO / VTM)
//   IMESSAGE_TO                 your iMessage handle: +1XXXXXXXXXX or Apple ID email
//   SCALESOLO_API_BASE          optional, default https://www.scalesolo.ai
//   WINDOW_MIN                  optional, default 45 (how far back to catch go-lives)
//   TIKTOK_TEXTER_STATE         optional, default ~/.scalesolo/tiktok-texter-sent.json

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// ── Load config (env files layered under real env) ───────────────────
function loadEnvFile(path) {
  if (!path || !existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const k = line.slice(0, eq).trim()
    let v = line.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (!(k in process.env)) process.env[k] = v
  }
}
loadEnvFile(join(HERE, 'texter.env'))
loadEnvFile(join(homedir(), '.scalesolo', 'texter.env'))

const API_BASE = (process.env.SCALESOLO_API_BASE || 'https://www.scalesolo.ai').replace(/\/$/, '')
const SECRET = process.env.SCALESOLO_INTERNAL_SECRET
const USER_ID = process.env.SCALESOLO_USER_ID
const PROFILE_ID = process.env.SCALESOLO_PROFILE_ID
const IMESSAGE_TO = process.env.IMESSAGE_TO
const WINDOW_MIN = Number(process.env.WINDOW_MIN || 45)
const STATE_FILE = process.env.TIKTOK_TEXTER_STATE || join(homedir(), '.scalesolo', 'tiktok-texter-sent.json')

const missing = ['SCALESOLO_INTERNAL_SECRET', 'SCALESOLO_USER_ID', 'SCALESOLO_PROFILE_ID', 'IMESSAGE_TO']
  .filter((k) => !process.env[k])
if (missing.length) {
  console.error(`tiktok-texter: missing config: ${missing.join(', ')}. See README.`)
  process.exit(1)
}

const log = (...a) => console.error(`[tiktok-texter ${new Date().toISOString()}]`, ...a)

// ── Dedup state ──────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return { sent: {} } }
}
function saveState(state) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch (e) { log('WARN could not persist state:', e.message) }
}

// ── iMessage via AppleScript (argv-passed, so no quoting hazards) ─────
const APPLESCRIPT = `on run argv
  set targetTo to item 1 of argv
  set targetMessage to item 2 of argv
  tell application "Messages"
    set svc to 1st service whose service type = iMessage
    set theBuddy to participant targetTo of svc
    send targetMessage to theBuddy
  end tell
end run`

function sendIMessage(to, message, timeoutMs = 20000) {
  // Default 20s timeout so a pending macOS Automation-permission prompt (or a
  // wedged Messages) can never hang the scheduled agent — it aborts and
  // retries next run. The --test path passes a longer timeout so there's time
  // to find and click the one-time permission dialog.
  execFileSync('osascript', ['-', to, message], { input: APPLESCRIPT, stdio: ['pipe', 'ignore', 'pipe'], timeout: timeoutMs })
}

// Two messages per go-live:
//   1. context — which post this is (kind + title), plus the nudge
//   2. ONLY the caption + hashtags, so the whole message is paste-ready
function buildMessages(item) {
  const title = (item.title || 'Untitled').trim()
  const caption = (item.caption || '').trim()
  const hashtags = (item.hashtags || '').trim()
  const kind = item.media_type === 'carousel' ? 'carousel'
    : item.media_type === 'video' ? 'video' : 'post'

  const context = `🎬 TikTok draft is live — post it from the app.\n${kind}: "${title}"\n(next text is the caption + hashtags, ready to paste)`

  const paste = [caption, hashtags].filter(Boolean).join('\n\n')

  return [context, paste].filter((m) => m && m.trim())
}

async function main() {
  const r = await fetch(`${API_BASE}/api/content?profile_id=${encodeURIComponent(PROFILE_ID)}&filter=calendar`, {
    headers: { 'x-internal-secret': SECRET, 'x-impersonate-user': USER_ID },
  })
  if (!r.ok) { log(`content fetch failed (${r.status}): ${(await r.text()).slice(0, 200)}`); process.exit(1) }
  const { items = [] } = await r.json()

  const now = Date.now()
  const lowerBound = now - WINDOW_MIN * 60 * 1000
  const state = loadState()

  const due = items.filter((it) => {
    if (state.sent[it.id]) return false
    const plats = Array.isArray(it.platforms) ? it.platforms.map((p) => String(p).toLowerCase()) : []
    if (!plats.includes('tiktok')) return false
    if (!it.scheduled_datetime) return false
    const t = new Date(it.scheduled_datetime).getTime()
    return t <= now && t >= lowerBound
  })

  for (const it of due) {
    try {
      for (const msg of buildMessages(it)) sendIMessage(IMESSAGE_TO, msg)
      state.sent[it.id] = now
      log(`texted "${(it.title || '').slice(0, 60)}" (${it.id})`)
    } catch (e) {
      log(`FAILED to text ${it.id}: ${e.message}`)
    }
  }

  // Prune dedup entries older than 7 days so the file stays small.
  const cutoff = now - 7 * 24 * 60 * 60 * 1000
  for (const [id, ts] of Object.entries(state.sent)) if (ts < cutoff) delete state.sent[id]
  saveState(state)

  if (!due.length) log('nothing due')
}

// `--test` sends one iMessage immediately (same code path the timer uses) so
// you can approve the one-time macOS "control Messages" prompt and confirm
// delivery, without waiting for a real go-live.
if (process.argv.includes('--test')) {
  try {
    log('sending test — if a "Terminal wants access to control Messages" dialog appears, click OK (you have ~2 min)…')
    // Preview the real two-message shape with sample copy.
    const sample = {
      media_type: 'video',
      title: 'When to use a Skill in Claude',
      caption: "Here's when to use a Skill in Claude, and how to build one, so it runs your repeat tasks the same way every time. Follow @RayvaughnCEO for more AI tips for small business owners.",
      hashtags: '#katytx #katytexas #cypresstx #cincoranch #thingstodoinkaty',
    }
    const msgs = buildMessages(sample)
    sendIMessage(IMESSAGE_TO, msgs[0], 120000)
    for (const m of msgs.slice(1)) sendIMessage(IMESSAGE_TO, m)
    log(`test messages sent to ${IMESSAGE_TO}`)
    process.exit(0)
  } catch (e) {
    log('test send failed:', e.message)
    process.exit(1)
  }
}

main().catch((e) => { log('fatal:', e.message); process.exit(1) })
